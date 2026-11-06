import { describe, it, expect, afterEach } from 'vitest';
import color from '../lib/color.js';

describe('colorEnabled — NO_COLOR semantics', () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
  });

  it('leaves color on when NO_COLOR is empty', () => {
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = '';
    expect(color.colorEnabled({ isTTY: true })).toBe(true);
  });

  it('disables color when NO_COLOR is non-empty', () => {
    process.env.NO_COLOR = '1';
    expect(color.colorEnabled({ isTTY: true })).toBe(false);
  });
});
