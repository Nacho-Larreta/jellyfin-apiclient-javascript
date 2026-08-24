import ApiClient from '../src/apiClient';

const ACCESS_TOKEN_MARKER = 'ACCESS_TOKEN_MARKER_&= +/%?#ü';
const DEVICE_ID_MARKER = 'DEVICE_ID_MARKER_&= +/%?#ñ';

class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        FakeWebSocket.instances.push(this);
    }
}

FakeWebSocket.CONNECTING = 0;
FakeWebSocket.instances = [];
FakeWebSocket.OPEN = 1;

function spyOnConsole() {
    return ['debug', 'error', 'log', 'warn'].map((method) => jest.spyOn(console, method).mockImplementation());
}

function collectInspectableValues(value, seen = new Set()) {
    if (typeof value === 'string') {
        return [value];
    }

    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || seen.has(value)) {
        return [];
    }

    seen.add(value);
    return Object.keys(value).flatMap((key) => [key, ...collectInspectableValues(value[key], seen)]);
}

function inspectConsoleArguments(spies) {
    return spies.flatMap((spy) =>
        spy.mock.calls.flatMap((call) => call.flatMap((value) => collectInspectableValues(value)))
    );
}

describe('ApiClient WebSocket authentication', () => {
    let originalWebSocket;
    let consoleSpies;

    beforeEach(() => {
        originalWebSocket = globalThis.WebSocket;
        globalThis.WebSocket = FakeWebSocket;
        FakeWebSocket.instances = [];
        consoleSpies = spyOnConsole();
    });

    afterEach(() => {
        globalThis.WebSocket = originalWebSocket;
        consoleSpies.forEach((spy) => spy.mockRestore());
    });

    it.each([
        ['https://media.example.test/jellyfin', 'wss:', '/jellyfin/socket'],
        ['http://media.example.test/emby', 'ws:', '/embywebsocket']
    ])('opens %s with a canonical, encoded authentication query', (serverAddress, protocol, pathname) => {
        const client = new ApiClient(serverAddress, 'Synthetic Client', '1.0.0', 'Synthetic Device', DEVICE_ID_MARKER);
        client.enableAutomaticBitrateDetection = false;
        client.setAuthenticationInfo(ACCESS_TOKEN_MARKER, 'synthetic-user');

        client.openWebSocket();

        expect(FakeWebSocket.instances).toHaveLength(1);
        const socket = FakeWebSocket.instances[0];
        const socketUrl = new URL(socket.url);
        expect(socketUrl.protocol).toBe(protocol);
        expect(socketUrl.pathname).toBe(pathname);
        expect(socketUrl.searchParams.get('ApiKey')).toBe(ACCESS_TOKEN_MARKER);
        expect(socketUrl.searchParams.get('deviceId')).toBe(DEVICE_ID_MARKER);
        expect(socketUrl.searchParams.has('api_key')).toBe(false);
        expect([...socketUrl.searchParams.keys()]).toStrictEqual(['ApiKey', 'deviceId']);
        expect(socket.url).not.toContain(ACCESS_TOKEN_MARKER);
        expect(socket.url).not.toContain(DEVICE_ID_MARKER);
        expect(socket.onmessage).toBeInstanceOf(Function);
        expect(socket.onopen).toBeInstanceOf(Function);
        expect(socket.onerror).toBeInstanceOf(Function);
        expect(socket.onclose).toBeInstanceOf(Function);

        socket.onerror();
        socket.onclose();

        const loggedValues = inspectConsoleArguments(consoleSpies);
        [ACCESS_TOKEN_MARKER, DEVICE_ID_MARKER, socket.url].forEach((sensitiveValue) => {
            expect(loggedValues.some((loggedValue) => loggedValue.includes(sensitiveValue))).toBe(false);
        });
        expect(consoleSpies.flatMap((spy) => spy.mock.calls.flat())).not.toContain(socket);
    });
});
