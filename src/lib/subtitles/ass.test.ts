import { describe, expect, it } from 'vitest';
import { parseAssAsText } from './ass';

const ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,28

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,not shown
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\i1}Привет из ASS{\\i0}
Dialogue: 0,0:00:06.50,0:00:09.00,Default,,0,0,0,,One, two\\Nthree\\hfour
`;

describe('parseAssAsText', () => {
  it('turns Dialogue lines into plain-text cues', () => {
    expect(parseAssAsText(ASS)).toEqual([
      { start: 2, end: 4, text: 'Привет из ASS' },
      { start: 6.5, end: 9, text: 'One, two\nthree\u00A0four' },
    ]);
  });

  it('follows the Format line order (SSA v4 has Marked instead of Layer)', () => {
    const ssa =
      '[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      'Dialogue: Marked=0,0:01:00.00,0:01:01.00,Default,,0,0,0,,SSA line';
    expect(parseAssAsText(ssa)).toEqual([{ start: 60, end: 61, text: 'SSA line' }]);
  });
});
