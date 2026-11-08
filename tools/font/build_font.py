#!/usr/bin/env python3
"""Build the Baron8 bitmap font from glyphs.py and embed it in style.css.

Each '#' in a glyph becomes one font pixel (128 font units). Pixel runs are
unioned into clean outlines so the font renders without seams.

Usage:  python3 tools/font/build_font.py [--ttf out.ttf]
Needs:  pip install -r tools/requirements.txt
"""
import argparse
import base64
import io
import pathlib
import re
import sys

import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
from glyphs import G  # noqa: E402

PX = 128          # font units per pixel
UPM = 8 * PX      # 8x8 cell
NAMES = {' ': 'space'}


def glyph_name(ch):
    return NAMES.get(ch, 'uni%04X' % ord(ch))


def outline(rows):
    path = pathops.Path()
    for r, row in enumerate(rows):
        y0 = (6 - r) * PX  # rows 0-6 above the baseline, row 7 below
        c = 0
        while c < 8:
            if row[c] != '#':
                c += 1
                continue
            start = c
            while c < 8 and row[c] == '#':
                c += 1
            rect = pathops.Path()
            rect.moveTo(start * PX, y0)
            rect.lineTo(start * PX, y0 + PX)
            rect.lineTo(c * PX, y0 + PX)
            rect.lineTo(c * PX, y0)
            rect.close()
            path = pathops.op(path, rect, pathops.PathOp.UNION)
    pen = TTGlyphPen(None)
    path.draw(pen)
    return pen.glyph()


def build():
    order = ['.notdef'] + [glyph_name(c) for c in G]
    glyphs = {'.notdef': TTGlyphPen(None).glyph()}
    for ch, rows in G.items():
        glyphs[glyph_name(ch)] = outline(rows)
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({ord(c): glyph_name(c) for c in G})
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n: (UPM, 0) for n in order})
    fb.setupHorizontalHeader(ascent=7 * PX, descent=-PX)
    fb.setupOS2(sTypoAscender=7 * PX, sTypoDescender=-PX, sTypoLineGap=0,
                usWinAscent=7 * PX, usWinDescent=PX)
    fb.setupNameTable({'familyName': 'Baron8', 'styleName': 'Regular'})
    fb.setupPost(isFixedPitch=1)
    # Fixed timestamps so rebuilding unchanged glyphs gives identical bytes.
    fb.font['head'].created = fb.font['head'].modified = 0
    fb.font.recalcTimestamp = False
    buf = io.BytesIO()
    fb.save(buf)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--ttf', help='also write the raw .ttf to this path')
    ap.add_argument('--css', default=str(ROOT / 'style.css'), help='stylesheet to update')
    args = ap.parse_args()

    for ch, rows in G.items():
        if len(rows) != 8 or any(len(r) != 8 for r in rows):
            sys.exit('glyph %r is not 8x8' % ch)

    ttf = build()
    if args.ttf:
        pathlib.Path(args.ttf).write_bytes(ttf)

    css_path = pathlib.Path(args.css)
    css = css_path.read_text()
    b64 = base64.b64encode(ttf).decode()
    new, n = re.subn(r'url\(data:font/ttf;base64,[^)]*\)', 'url(data:font/ttf;base64,%s)' % b64, css, count=1)
    if n != 1:
        sys.exit('could not find the embedded Baron8 font in %s' % css_path)
    css_path.write_text(new)
    print('%d glyphs, %d bytes base64 -> %s' % (len(G), len(b64), css_path.name))


if __name__ == '__main__':
    main()
