import Credentials from '../src/credentials';

const ACCESS_TOKEN_MARKER = 'STORED_ACCESS_TOKEN_MARKER_&= +/%?#ü';

function createStorage(storedCredentials) {
    return {
        getItem: jest.fn(() => JSON.stringify(storedCredentials)),
        removeItem: jest.fn(),
        setItem: jest.fn()
    };
}

describe('Credentials initialization', () => {
    let originalLocalStorage;
    let consoleSpies;

    beforeEach(() => {
        originalLocalStorage = globalThis.localStorage;
        globalThis.localStorage = createStorage({
            Servers: [{ Id: 'synthetic-server', AccessToken: ACCESS_TOKEN_MARKER }]
        });
        consoleSpies = ['debug', 'error', 'log', 'warn'].map((method) =>
            jest.spyOn(console, method).mockImplementation()
        );
    });

    afterEach(() => {
        globalThis.localStorage = originalLocalStorage;
        consoleSpies.forEach((spy) => spy.mockRestore());
    });

    it('loads stored credentials without logging their serialized value', () => {
        const credentials = new Credentials('synthetic_credentials');

        expect(credentials.credentials().Servers[0].AccessToken).toBe(ACCESS_TOKEN_MARKER);
        const loggedValues = consoleSpies.flatMap((spy) => spy.mock.calls.flat()).join(' ');
        expect(loggedValues).not.toContain(ACCESS_TOKEN_MARKER);
    });
});
