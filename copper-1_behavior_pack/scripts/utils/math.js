import { Direction } from '@minecraft/server';

export function areVectorsEqual(vector1, vector2) {
    return (vector1.x === vector2.x &&
        vector1.y === vector2.y &&
        vector1.z === vector2.z);
}

export function clamp(number, min, max) {
    return Math.max(min, Math.min(number, max));
}

export function directionToVector3(direction) {
    switch (direction) {
        case Direction.Down:
            return { x: 0, y: -1, z: 0 };
        case Direction.Up:
            return { x: 0, y: 1, z: 0 };
        case Direction.North:
            return { x: 0, y: 0, z: -1 };
        case Direction.South:
            return { x: 0, y: 0, z: 1 };
        case Direction.West:
            return { x: -1, y: 0, z: 0 };
        case Direction.East:
            return { x: 1, y: 0, z: 0 };
    }
}
export function vectorOfCenter(vector) {
    return { x: vector.x + 0.5, y: vector.y + 0.5, z: vector.z + 0.5 };
}
export function nextDouble(min, max) {
    if (min >= max)
        return min;
    return Math.random() * (max - min) + min;
}
export function getRandomVelocity() {
    return {
        x: nextDouble(-0.5, 0.5),
        y: nextDouble(-0.5, 0.5),
        z: nextDouble(-0.5, 0.5)
    };
}
export function lerp(delta, start, end) {
    return start + delta * (end - start);
}
