const deliveryOwners = new WeakMap();

export const MAX_MESSAGE_IDS = 512;

export function captureSocketBinding(client) {
    return Object.freeze({
        address: client.serverAddress(),
        serverId: client.serverId(),
        userId: client.getCurrentUserId(),
        accessToken: client.accessToken(),
        deviceId: client.deviceId()
    });
}

export function matchesSocketBinding(client, binding) {
    try {
        const current = captureSocketBinding(client);
        return current.address === binding.address &&
            current.serverId === binding.serverId &&
            current.userId === binding.userId &&
            current.accessToken === binding.accessToken &&
            current.deviceId === binding.deviceId;
    } catch (_) {
        return false;
    }
}

const legacyGuard = Object.freeze({ isCurrent: () => true });

export function captureSocketGuard(provider) {
    if (!provider) {
        return legacyGuard;
    }

    try {
        const supplied = provider();
        if (!supplied || typeof supplied.isCurrent !== 'function') {
            return null;
        }
        const guard = Object.freeze({ isCurrent: supplied.isCurrent.bind(supplied) });
        return guardIsCurrent(guard) ? guard : null;
    } catch (_) {
        return null;
    }
}

export function guardIsCurrent(guard) {
    try {
        return Boolean(guard && guard.isCurrent());
    } catch (_) {
        return false;
    }
}

export function createMessageDelivery(client, isCurrent) {
    const delivery = Object.freeze({ isCurrent });
    deliveryOwners.set(delivery, client);
    return delivery;
}

export function belongsToClient(delivery, client) {
    return deliveryOwners.get(delivery) === client;
}

export function rememberMessageId(ids, id) {
    if (ids.has(id)) {
        return false;
    }

    ids.set(id, true);
    if (ids.size > MAX_MESSAGE_IDS) {
        ids.delete(ids.keys().next().value);
    }
    return true;
}
