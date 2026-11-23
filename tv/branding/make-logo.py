#!/usr/bin/env python3
"""Writes banner.svg (the 16:9 tile a TV launcher shows) and icon.svg (the square app icon).

The mark is a ring of particles, as on Mineradio's stage, open at the lower right where the
wordmark's "tv" sits. Deterministic: the same files every run."""
import math, random

MINT, VIOLET = (127, 227, 176), (185, 164, 255)

def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def ring(cx, cy, radius, rows, seed, gap=None, scale=1.0):
    """Dots on concentric circles: bigger and brighter on the middle rows, coloured around the ring."""
    rnd = random.Random(seed)
    out = []
    for row in range(rows):
        r = radius * (0.80 + 0.40 * row / max(1, rows - 1))
        count = int(2 * math.pi * r / (7.2 * scale))
        weight = 1 - abs(row - (rows - 1) / 2) / ((rows - 1) / 2 + 0.6)
        for i in range(count):
            a = 2 * math.pi * i / count + row * 0.21
            deg = math.degrees(a) % 360
            if gap and gap[0] <= deg <= gap[1]:
                continue
            t = (math.sin(a - 0.9) + 1) / 2
            c = mix(MINT, VIOLET, t)
            wobble = 1 + 0.035 * math.sin(a * 5 + row)
            x, y = cx + r * wobble * math.cos(a), cy + r * wobble * math.sin(a)
            size = scale * (0.9 + 1.5 * weight) * (0.75 + 0.5 * rnd.random())
            opacity = 0.22 + 0.70 * weight * (0.6 + 0.4 * rnd.random())
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{size:.2f}" fill="rgb{c}" opacity="{opacity:.2f}"/>')
    return "\n".join(out)

DEFS = '''<defs>
  <radialGradient id="bg" cx="50%" cy="46%" r="75%">
    <stop offset="0" stop-color="#1b1630"/><stop offset="0.55" stop-color="#0c0a15"/><stop offset="1" stop-color="#050508"/>
  </radialGradient>
  <linearGradient id="tv" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7fe3b0"/><stop offset="1" stop-color="#b9a4ff"/>
  </linearGradient>
  <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.05"/><stop offset="0.4" stop-color="#ffffff" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="veil" cx="50%" cy="50%" r="50%">
    <stop offset="0" stop-color="#07060c" stop-opacity="0.95"/><stop offset="0.72" stop-color="#07060c" stop-opacity="0.9"/><stop offset="1" stop-color="#07060c" stop-opacity="0"/>
  </radialGradient>
</defs>'''
FONT = "font-family=\"'SF Pro Display','Helvetica Neue',Helvetica,Arial,sans-serif\""

banner = f'''<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
{DEFS}
<rect width="640" height="360" fill="url(#bg)"/>
{ring(320, 180, 132, 7, 7, gap=None, scale=1.0)}
<ellipse cx="320" cy="180" rx="262" ry="70" fill="url(#veil)"/>
<text x="284" y="201" text-anchor="middle" {FONT} font-size="62" font-weight="700" letter-spacing="-1.5" fill="#ffffff">Mineradio</text>
<text x="442" y="201" {FONT} font-size="62" font-weight="300" letter-spacing="-1" fill="url(#tv)">tv</text>
<rect width="640" height="360" fill="url(#sheen)"/>
</svg>
'''
icon = f'''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
{DEFS}
<rect width="512" height="512" rx="112" fill="url(#bg)"/>
{ring(256, 256, 150, 7, 11, gap=(18, 62), scale=1.25)}
<text x="246" y="302" text-anchor="middle" {FONT} font-size="150" font-weight="700" letter-spacing="-4" fill="#ffffff">M</text>
<text x="352" y="398" {FONT} font-size="76" font-weight="300" letter-spacing="-1" fill="url(#tv)">tv</text>
<rect width="512" height="512" rx="112" fill="url(#sheen)"/>
</svg>
'''
open('banner.svg', 'w').write(banner)
open('icon.svg', 'w').write(icon)
print('wrote banner.svg, icon.svg')
