import { describe, it, expect } from 'vitest';

describe('Bot Sanity Check', () => {
    it('should pass a basic truthy test', () => {
        expect(true).toBe(true);
    });

    it('should be able to perform basic math', () => {
        expect(1 + 1).toBe(2);
    });
});
