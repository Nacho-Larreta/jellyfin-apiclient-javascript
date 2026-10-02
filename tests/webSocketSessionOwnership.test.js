import ApiClient from '../src/apiClient';
import events from '../src/events';

class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.send = jest.fn();
        this.close = jest.fn(() => {
            this.readyState = FakeWebSocket.CLOSING;
        });
        FakeWebSocket.instances.push(this);
    }
}

FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.instances = [];

function createClient(userId = 'user-a') {
    const client = new ApiClient('https://media.example.test', 'Test', '1', 'Device', 'device-a');
    client.enableAutomaticBitrateDetection = false;
    client.serverInfo({ Id: 'server-a' });
    client.setAuthenticationInfo(`token-${userId}`, userId);
    return client;
}

function currentGrant() {
    let allowed = true;
    return {
        guard: Object.freeze({ isCurrent: () => allowed }),
        revoke: () => { allowed = false; }
    };
}

function savedHandlers(socket) {
    return {
        onopen: socket.onopen,
        onerror: socket.onerror,
        onclose: socket.onclose,
        onmessage: socket.onmessage
    };
}

describe('session-owned WebSocket delivery', () => {
    let originalWebSocket;

    beforeEach(() => {
        originalWebSocket = globalThis.WebSocket;
        globalThis.WebSocket = FakeWebSocket;
        FakeWebSocket.instances = [];
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.spyOn(console, 'log').mockImplementation();
        jest.spyOn(console, 'debug').mockImplementation();
    });

    afterEach(() => {
        globalThis.WebSocket = originalWebSocket;
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it.each([FakeWebSocket.CONNECTING, FakeWebSocket.OPEN, FakeWebSocket.CLOSING])('invalidates state %s before closing and ignores every saved A callback after B opens', (state) => {
        const client = createClient();
        const grantA = currentGrant();
        const grantB = currentGrant();
        const provider = jest.fn().mockReturnValueOnce(grantA.guard).mockReturnValue(grantB.guard);
        client.setWebSocketSessionProvider(provider);
        const messages = [];
        const opened = jest.fn();
        const errors = jest.fn();
        const closed = jest.fn();
        events.on(client, 'message', (event, message) => messages.push(message));
        events.on(client, 'websocketopen', opened);
        events.on(client, 'websocketerror', errors);
        events.on(client, 'websocketclose', closed);

        client.openWebSocket();
        const socketA = FakeWebSocket.instances[0];
        socketA.readyState = state;
        const old = savedHandlers(socketA);
        grantA.revoke();
        client.closeWebSocket();
        client.openWebSocket();
        const socketB = FakeWebSocket.instances[1];
        socketB.readyState = FakeWebSocket.OPEN;
        socketB.onopen();
        const currentUser = { Id: 'user-a' };
        client._currentUser = currentUser;

        old.onopen();
        old.onerror();
        old.onmessage({ data: JSON.stringify({ MessageType: 'UserDeleted', MessageId: 'shared' }) });
        old.onmessage({ data: JSON.stringify({ MessageType: 'ForceKeepAlive', Data: 2 }) });
        old.onclose();
        jest.runOnlyPendingTimers();

        expect(socketA.close).toHaveBeenCalledTimes(1);
        expect(client.isWebSocketOpen()).toBe(true);
        expect(client._currentUser).toBe(currentUser);
        expect(messages).toEqual([]);
        expect(opened).toHaveBeenCalledTimes(1);
        expect(errors).not.toHaveBeenCalled();
        expect(closed).not.toHaveBeenCalled();
        expect(socketB.send).not.toHaveBeenCalled();

        socketB.onmessage({ data: JSON.stringify({ MessageType: 'Play', MessageId: 'shared' }) });
        expect(messages).toEqual([{ MessageType: 'Play', MessageId: 'shared' }]);
    });

    it('does not let a throwing close preserve old authority or prevent a successor', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        client.openWebSocket();
        const socketA = FakeWebSocket.instances[0];
        const oldMessage = socketA.onmessage;
        socketA.close.mockImplementation(() => { throw new Error('native close failed'); });
        const observed = jest.fn();
        events.on(client, 'message', observed);

        expect(() => client.closeWebSocket()).not.toThrow();
        client.openWebSocket();
        oldMessage({ data: JSON.stringify({ MessageType: 'Play' }) });

        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(observed).not.toHaveBeenCalled();
    });

    it('denies opening without a grant and never resurrects a revoked socket on A-B-A', () => {
        const client = createClient();
        let grant = null;
        client.setWebSocketSessionProvider(() => grant);
        client.openWebSocket();
        expect(FakeWebSocket.instances).toHaveLength(0);

        const originalGrant = currentGrant();
        grant = originalGrant.guard;
        client.openWebSocket();
        const socketA = FakeWebSocket.instances[0];
        const oldMessage = socketA.onmessage;
        originalGrant.revoke();
        client.setAuthenticationInfo('token-user-b', 'user-b');
        client.setAuthenticationInfo('token-user-a', 'user-a');
        grant = currentGrant().guard;
        client.openWebSocket();
        const observed = jest.fn();
        events.on(client, 'message', observed);
        oldMessage({ data: JSON.stringify({ MessageType: 'Play' }) });

        expect(observed).not.toHaveBeenCalled();
        expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('binds keepalive to one socket and rejects invalid intervals', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        client.openWebSocket();
        const socketA = FakeWebSocket.instances[0];
        socketA.readyState = FakeWebSocket.OPEN;
        socketA.onmessage({ data: JSON.stringify({ MessageType: 'ForceKeepAlive', Data: 2 }) });
        expect(socketA.send).toHaveBeenCalledTimes(1);
        client.closeWebSocket();
        client.openWebSocket();
        const socketB = FakeWebSocket.instances[1];
        socketB.readyState = FakeWebSocket.OPEN;
        jest.advanceTimersByTime(3000);
        expect(socketB.send).not.toHaveBeenCalled();

        for (const timeout of [0, -1, 'bad', null, Infinity]) {
            socketB.onmessage({ data: JSON.stringify({ MessageType: 'ForceKeepAlive', Data: timeout }) });
        }
        jest.advanceTimersByTime(3000);
        expect(socketB.send).toHaveBeenCalledTimes(5);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('keeps a captured old interval callback inert after a new socket opens', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        const timerSpy = jest.spyOn(globalThis, 'setInterval');
        client.openWebSocket();
        const socketA = FakeWebSocket.instances[0];
        socketA.readyState = FakeWebSocket.OPEN;
        socketA.onmessage({ data: JSON.stringify({ MessageType: 'ForceKeepAlive', Data: 2 }) });
        const oldTick = timerSpy.mock.calls[0][0];
        client.closeWebSocket();
        client.openWebSocket();
        const socketB = FakeWebSocket.instances[1];
        socketB.readyState = FakeWebSocket.OPEN;
        oldTick();
        expect(socketA.send).toHaveBeenCalledTimes(1);
        expect(socketB.send).not.toHaveBeenCalled();
    });

    it('requires an opaque current context for queued injection and shares bounded dedupe with the socket', () => {
        const client = createClient();
        const grant = currentGrant();
        client.setWebSocketSessionProvider(() => grant.guard);
        client.openWebSocket();
        const socket = FakeWebSocket.instances[0];
        const context = client.captureMessageDelivery();
        const received = jest.fn();
        events.on(client, 'message', received);
        socket.onmessage({ data: JSON.stringify({ MessageType: 'Play', MessageId: 'same' }) });
        client.handleMessageReceived({ MessageType: 'Play', MessageId: 'same' }, context);
        expect(received).toHaveBeenCalledTimes(1);
        expect(Object.isFrozen(context)).toBe(true);
        expect(client.handleMessageReceived({ MessageType: 'Play' }, { isCurrent: () => true })).toBeUndefined();
        expect(received).toHaveBeenCalledTimes(1);

        grant.revoke();
        client.handleMessageReceived({ MessageType: 'UserDeleted' }, context);
        client.handleMessageReceived({ MessageType: 'UserDeleted' });
        expect(received).toHaveBeenCalledTimes(1);
    });

    it('preserves current message events and rejects malformed messages before mutation', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        client.openWebSocket();
        const socket = FakeWebSocket.instances[0];
        const received = jest.fn();
        const opened = jest.fn();
        const closed = jest.fn();
        events.on(client, 'message', received);
        events.on(client, 'websocketopen', opened);
        events.on(client, 'websocketclose', closed);
        socket.readyState = FakeWebSocket.OPEN;
        socket.onopen();
        socket.onmessage({ data: '{bad' });
        socket.onmessage({ data: JSON.stringify({ MessageType: 'Play' }) });
        expect(opened).toHaveBeenCalledTimes(1);
        expect(received).toHaveBeenCalledTimes(1);
        expect(received.mock.calls[0][2].isCurrent()).toBe(true);
        socket.readyState = FakeWebSocket.CLOSING;
        socket.onclose();
        jest.runOnlyPendingTimers();
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it('invalidates immediately when the provider, credentials, server or address changes', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        client.openWebSocket();
        const first = FakeWebSocket.instances[0];
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        expect(first.close).toHaveBeenCalledTimes(1);
        client.openWebSocket();
        const second = FakeWebSocket.instances[1];
        client.setAuthenticationInfo('changed', 'user-a');
        expect(second.close).toHaveBeenCalledTimes(1);
        client.openWebSocket();
        const third = FakeWebSocket.instances[2];
        client.serverInfo({ Id: 'server-b', UserId: 'user-a', AccessToken: 'changed' });
        expect(third.close).toHaveBeenCalledTimes(1);
        client.openWebSocket();
        const fourth = FakeWebSocket.instances[3];
        client.serverAddress('https://other.example.test');
        expect(fourth.close).toHaveBeenCalledTimes(1);
    });

    it('rejects a mutable server-info change even when no setter notification runs', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        client.openWebSocket();
        const socket = FakeWebSocket.instances[0];
        const received = jest.fn();
        events.on(client, 'message', received);
        client._serverInfo.Id = 'server-b';
        socket.onmessage({ data: JSON.stringify({ MessageType: 'Play' }) });
        expect(received).not.toHaveBeenCalled();
        expect(socket.close).toHaveBeenCalledTimes(1);
    });

    it('rejects reentrant binding changes during grant capture and socket construction', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => {
            client.setAuthenticationInfo('token-user-b', 'user-b');
            return currentGrant().guard;
        });
        client.openWebSocket();
        expect(FakeWebSocket.instances).toHaveLength(0);

        client.setWebSocketSessionProvider(() => currentGrant().guard);
        const OriginalSocket = globalThis.WebSocket;
        globalThis.WebSocket = class extends OriginalSocket {
            constructor(url) {
                super(url);
                client.setAuthenticationInfo('token-user-c', 'user-c');
            }
        };
        client.openWebSocket();
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(FakeWebSocket.instances[0].close).toHaveBeenCalledTimes(1);
        expect(client.isWebSocketOpenOrConnecting()).toBe(false);
    });

    it('denies a throwing provider without disclosing its error or constructing a socket', () => {
        const client = createClient();
        const error = new Error('SYNTHETIC_SECRET');
        client.setWebSocketSessionProvider(() => { throw error; });
        expect(() => client.openWebSocket()).not.toThrow();
        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(console.log.mock.calls.flat().join(' ')).not.toContain('SYNTHETIC_SECRET');
    });

    it('captures the guard method once rather than trusting a later replacement', () => {
        const client = createClient();
        let allowed = true;
        const supplied = { isCurrent: () => allowed };
        client.setWebSocketSessionProvider(() => supplied);
        client.openWebSocket();
        const socket = FakeWebSocket.instances[0];
        const received = jest.fn();
        events.on(client, 'message', received);
        allowed = false;
        supplied.isCurrent = () => true;
        socket.onmessage({ data: JSON.stringify({ MessageType: 'Play' }) });
        expect(received).not.toHaveBeenCalled();
        expect(socket.close).toHaveBeenCalledTimes(1);
    });

    it('stops generic socket message delivery when the first listener changes authority', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        client.openWebSocket();
        const first = jest.fn(() => client.setAuthenticationInfo('token-user-b', 'user-b'));
        const second = jest.fn();
        events.on(client, 'message', first);
        events.on(client, 'message', second);

        FakeWebSocket.instances[0].onmessage({ data: JSON.stringify({ MessageType: 'Play' }) });

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
    });

    it('stops generic injected message delivery after the first listener changes authority', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        const first = jest.fn(() => client.setAuthenticationInfo('token-user-b', 'user-b'));
        const second = jest.fn();
        events.on(client, 'message', first);
        events.on(client, 'message', second);

        client.handleMessageReceived({ MessageType: 'GeneralCommand' });

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
    });

    it('delivers a current generic message to both registered listeners', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        const first = jest.fn();
        const second = jest.fn();
        events.on(client, 'message', first);
        events.on(client, 'message', second);
        client.handleMessageReceived({ MessageType: 'Play' });
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
    });

    it.each(['websocketopen', 'websocketerror'])('stops %s listeners after first changes authority', (eventName) => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        client.openWebSocket();
        const socket = FakeWebSocket.instances[0];
        socket.readyState = FakeWebSocket.OPEN;
        const first = jest.fn(() => client.setAuthenticationInfo('token-user-b', 'user-b'));
        const second = jest.fn();
        events.on(client, eventName, first);
        events.on(client, eventName, second);

        if (eventName === 'websocketopen') {
            socket.onopen();
        } else {
            socket.onerror();
        }

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
    });

    it('delivers current close to all listeners but stops after the first opens a successor', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        client.openWebSocket();
        const socket = FakeWebSocket.instances[0];
        socket.readyState = FakeWebSocket.OPEN;
        const currentFirst = jest.fn();
        const currentSecond = jest.fn();
        events.on(client, 'websocketclose', currentFirst);
        events.on(client, 'websocketclose', currentSecond);
        socket.onclose();
        jest.runOnlyPendingTimers();
        expect(currentFirst).toHaveBeenCalledTimes(1);
        expect(currentSecond).toHaveBeenCalledTimes(1);

        client.openWebSocket();
        const nextSocket = FakeWebSocket.instances[1];
        nextSocket.readyState = FakeWebSocket.OPEN;
        events.on(client, 'websocketclose', () => client.openWebSocket());
        const stale = jest.fn();
        events.on(client, 'websocketclose', stale);
        nextSocket.onclose();
        jest.runOnlyPendingTimers();
        expect(stale).not.toHaveBeenCalled();
    });

    it('uses the closing record revision even if native close reentrantly replaces the provider', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        client.openWebSocket();
        const socket = FakeWebSocket.instances[0];
        socket.readyState = FakeWebSocket.OPEN;
        socket.close.mockImplementation(() => {
            socket.readyState = FakeWebSocket.CLOSING;
            client.setWebSocketSessionProvider(() => currentGrant().guard);
        });
        const closed = jest.fn();
        events.on(client, 'websocketclose', closed);
        client.closeWebSocket();
        jest.runOnlyPendingTimers();
        expect(closed).not.toHaveBeenCalled();
    });

    it('preserves a current explicit close notification and cancels it after a successor opens', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        const closed = jest.fn();
        events.on(client, 'websocketclose', closed);
        client.openWebSocket();
        client.closeWebSocket();
        jest.runOnlyPendingTimers();
        expect(closed).toHaveBeenCalledTimes(1);

        client.openWebSocket();
        client.closeWebSocket();
        client.openWebSocket();
        jest.runOnlyPendingTimers();
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it('rejects a foreign context, but accepts current legacy one-argument injection', () => {
        const client = createClient();
        const other = createClient('user-b');
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        other.setWebSocketSessionProvider(() => currentGrant().guard);
        const foreign = other.captureMessageDelivery();
        const received = jest.fn();
        events.on(client, 'message', received);
        client.handleMessageReceived({ MessageType: 'Play' }, foreign);
        expect(received).not.toHaveBeenCalled();
        client.handleMessageReceived({ MessageType: 'Play' });
        expect(received).toHaveBeenCalledTimes(1);
    });

    it('rechecks admission after reading injected payload fields with reentrant getters', () => {
        const client = createClient();
        client.setWebSocketSessionProvider(() => currentGrant().guard);
        const currentUser = { Id: 'user-b' };
        const received = jest.fn();
        events.on(client, 'message', received);
        const payload = {
            get MessageType() {
                client.setAuthenticationInfo('token-user-b', 'user-b');
                client._currentUser = currentUser;
                return 'UserDeleted';
            },
            MessageId: 'reentrant'
        };
        client.handleMessageReceived(payload);
        expect(client._currentUser).toBe(currentUser);
        expect(received).not.toHaveBeenCalled();
        expect(client._messageIdsReceived.size).toBe(0);
    });

    it('bounds dedupe per client and evicts oldest IDs deterministically', () => {
        const client = createClient();
        const other = createClient('user-b');
        const received = jest.fn();
        const otherReceived = jest.fn();
        events.on(client, 'message', received);
        events.on(other, 'message', otherReceived);
        for (let index = 0; index < 513; index++) {
            client.handleMessageReceived({ MessageType: 'Play', MessageId: `id-${index}` });
        }
        client.handleMessageReceived({ MessageType: 'Play', MessageId: 'id-512' });
        client.handleMessageReceived({ MessageType: 'Play', MessageId: 'id-0' });
        other.handleMessageReceived({ MessageType: 'Play', MessageId: 'id-512' });
        expect(received).toHaveBeenCalledTimes(514);
        expect(otherReceived).toHaveBeenCalledTimes(1);
        expect(client._messageIdsReceived.size).toBe(512);
    });

    it('suppresses a duplicate across injected, opened and reconnected transport in one session', () => {
        const client = createClient();
        const guard = currentGrant().guard;
        client.setWebSocketSessionProvider(() => guard);
        const received = jest.fn();
        events.on(client, 'message', received);
        client.handleMessageReceived({ MessageType: 'Play', MessageId: 'replayed' });
        client.openWebSocket();
        const first = FakeWebSocket.instances[0];
        first.onmessage({ data: JSON.stringify({ MessageType: 'Play', MessageId: 'replayed' }) });
        client.closeWebSocket();
        client.openWebSocket();
        const second = FakeWebSocket.instances[1];
        second.onmessage({ data: JSON.stringify({ MessageType: 'Play', MessageId: 'replayed' }) });
        expect(received).toHaveBeenCalledTimes(1);
    });
});
