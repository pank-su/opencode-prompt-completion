import { RGBA } from '@opentui/core';

// Only the tokens consumed by the prompt adapter are needed for these tests.
export function testTheme(mode = 'dark') {
    const dark = mode === 'dark';
    return {
        text: {
            base: RGBA.fromHex(dark ? '#eeeeee' : '#111111'),
            muted: RGBA.fromHex(dark ? '#9e9e9e' : '#666666')
        },
        background: {
            base: RGBA.fromHex(dark ? '#141414' : '#ffffff'),
            raised: { base: RGBA.fromHex(dark ? '#202020' : '#f2f2f2') }
        }
    };
}
