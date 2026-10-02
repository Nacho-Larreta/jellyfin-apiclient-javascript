import events from '../src/events';

describe('Events', () => {
    it('contains an on property', () => {
        expect(events).toHaveProperty('on');
    });

    it('contains an off property', () => {
        expect(events).toHaveProperty('off');
    });

    it('contains a trigger property', () => {
        expect(events).toHaveProperty('trigger');
    });

    it('checks authority before each listener and stops permanently after revocation', () => {
        const source = {};
        const delivered = [];
        let current = true;
        events.on(source, 'message', function (event, message) {
            delivered.push({ receiver: this, event, message });
            current = false;
        });
        events.on(source, 'message', () => delivered.push('stale'));

        events.triggerGuarded(source, 'message', ['payload'], () => current);

        expect(delivered).toEqual([{
            receiver: source,
            event: { type: 'message' },
            message: 'payload'
        }]);
    });

    it('preserves callback order and snapshot semantics for a current dispatch', () => {
        const source = {};
        const received = [];
        const later = () => received.push('later');
        events.on(source, 'message', () => {
            received.push('first');
            events.on(source, 'message', later);
        });
        events.on(source, 'message', () => received.push('second'));

        events.triggerGuarded(source, 'message', [], () => true);

        expect(received).toEqual(['first', 'second']);
    });

    it('treats a throwing guard as denial but preserves listener exceptions', () => {
        const source = {};
        const received = jest.fn();
        events.on(source, 'message', received);
        expect(() => events.triggerGuarded(source, 'message', [], () => {
            throw new Error('private authority failure');
        })).not.toThrow();
        expect(received).not.toHaveBeenCalled();

        events.on(source, 'other', () => { throw new Error('listener failure'); });
        expect(() => events.triggerGuarded(source, 'other', [], () => true)).toThrow('listener failure');
    });

    it('never resumes later listeners after a denied check revives', () => {
        const source = {};
        const second = jest.fn();
        const third = jest.fn();
        events.on(source, 'message', jest.fn());
        events.on(source, 'message', second);
        events.on(source, 'message', third);
        let checks = 0;
        events.triggerGuarded(source, 'message', [], () => ++checks !== 2);
        expect(checks).toBe(2);
        expect(second).not.toHaveBeenCalled();
        expect(third).not.toHaveBeenCalled();
    });
});
