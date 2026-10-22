import { describe, expect, it } from 'vitest';
import {
  DOUBLE_TAP_MS,
  formatStreak,
  NO_TAPS,
  onTap,
  SEEK_STREAK_MS,
  streakStep,
  tapZone,
  type TapAction,
  type TapState,
  type TapZone,
} from './touch-seek';

/** Runs taps `[zone, at]` from no taps; returns every action and the last state. */
function taps(seq: [TapZone, number][], from: TapState = NO_TAPS) {
  let state = from;
  const actions: TapAction[] = [];
  for (const [zone, at] of seq) {
    const next = onTap(state, zone, at);
    state = next.state;
    actions.push(next.action);
  }
  return { state, actions };
}

const seeks = (actions: TapAction[]) =>
  actions.map((a) => (a.type === 'seek' ? [a.by, a.total] : a.type));

describe('tapZone', () => {
  it('splits the picture in thirds', () => {
    expect(tapZone(0, 900)).toBe('back');
    expect(tapZone(299, 900)).toBe('back');
    expect(tapZone(300, 900)).toBe('middle');
    expect(tapZone(599, 900)).toBe('middle');
    expect(tapZone(600, 900)).toBe('forward');
    expect(tapZone(900, 900)).toBe('forward');
    expect(tapZone(10, 0)).toBe('middle');
  });
});

describe('streakStep', () => {
  it('doubles from 5 s and stops at 5 min', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(streakStep)).toEqual([5, 10, 20, 40, 80, 160, 300, 300]);
  });
});

describe('onTap', () => {
  it('a middle tap acts at once and ends any streak', () => {
    const streak = taps([
      ['forward', 0],
      ['forward', 100],
    ]).state;
    expect(onTap(streak, 'middle', 200)).toEqual({ state: NO_TAPS, action: { type: 'tap' } });
  });

  it('a first side tap waits; a second on the same side within the window seeks 5 s', () => {
    const { actions, state } = taps([
      ['forward', 1000],
      ['forward', 1000 + DOUBLE_TAP_MS],
    ]);
    expect(seeks(actions)).toEqual(['wait', [5, 5]]);
    expect(state).toMatchObject({ side: 'forward', seeks: 1, total: 5 });
  });

  it('two taps too far apart are two plain taps', () => {
    const { actions } = taps([
      ['back', 0],
      ['back', DOUBLE_TAP_MS + 1],
    ]);
    expect(seeks(actions)).toEqual(['wait', 'wait']);
  });

  it('a streak forward doubles the step: +5, +10, +20, +40 (75 s in all)', () => {
    const { actions } = taps([
      ['forward', 0],
      ['forward', 200],
      ['forward', 800],
      ['forward', 1400],
      ['forward', 2000],
    ]);
    expect(seeks(actions)).toEqual(['wait', [5, 5], [10, 15], [20, 35], [40, 75]]);
  });

  it('back mirrors it', () => {
    const { actions } = taps([
      ['back', 0],
      ['back', 150],
      ['back', 300],
      ['back', 450],
    ]);
    expect(seeks(actions)).toEqual(['wait', [-5, 5], [-10, 15], [-20, 35]]);
  });

  it('the streak ends after its timeout: the next tap waits again', () => {
    const { actions } = taps([
      ['forward', 0],
      ['forward', 100],
      ['forward', 100 + SEEK_STREAK_MS + 1],
      ['forward', 100 + SEEK_STREAK_MS + 101],
    ]);
    expect(seeks(actions)).toEqual(['wait', [5, 5], 'wait', [5, 5]]);
  });

  it('the other side during a streak starts a new streak there at 5 s, at once', () => {
    const { actions } = taps([
      ['forward', 0],
      ['forward', 100],
      ['forward', 200],
      ['back', 300],
      ['back', 400],
    ]);
    expect(seeks(actions)).toEqual(['wait', [5, 5], [10, 15], [-5, 5], [-10, 15]]);
  });

  it('a first tap on the other side (no streak yet) waits there instead', () => {
    const { actions } = taps([
      ['forward', 0],
      ['back', 100],
      ['back', 200],
    ]);
    expect(seeks(actions)).toEqual(['wait', 'wait', [-5, 5]]);
  });

  it('caps the step at 5 min', () => {
    const seq: [TapZone, number][] = Array.from({ length: 10 }, (_, i) => ['forward', i * 100]);
    const last = taps(seq).actions.at(-1);
    expect(last).toMatchObject({ type: 'seek', by: 300 });
  });
});

describe('formatStreak', () => {
  it('says seconds, then minutes', () => {
    expect(formatStreak(5)).toBe('5 s');
    expect(formatStreak(35)).toBe('35 s');
    expect(formatStreak(155)).toBe('2 min 35 s');
    expect(formatStreak(300)).toBe('5 min');
  });
});
