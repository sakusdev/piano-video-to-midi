function rgbToHsv(red: number, green: number, blue: number) {
  const rn = red / 255;
  const gn = green / 255;
  const bn = blue / 255;
  const maximum = Math.max(rn, gn, bn);
  const minimum = Math.min(rn, gn, bn);
  const delta = maximum - minimum;
  let hue = 0;

  if (delta !== 0) {
    if (maximum === rn) hue = ((gn - bn) / delta) % 6;
    else if (maximum === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  return { h: hue, s: maximum === 0 ? 0 : delta / maximum, v: maximum };
}

export function hueFromHex(hex: string) {
  const stripped = hex.replace("#", "");
  const normalized = stripped.length === 3
    ? stripped.split("").map((character) => character + character).join("")
    : stripped;
  const value = Number.parseInt(normalized, 16);
  return rgbToHsv((value >> 16) & 255, (value >> 8) & 255, value & 255).h;
}
