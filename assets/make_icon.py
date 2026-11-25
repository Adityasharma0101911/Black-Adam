"""Generate the Black Adam app icon (assets/icon.png + assets/icon.ico). Run: python assets/make_icon.py

A gold lightning bolt cut into sound-wave bars on a black tile.
"""
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 2048  # draw at 2x, downscale for antialiasing
OUT = os.path.dirname(os.path.abspath(__file__))
GOLD_LIGHT, GOLD, GOLD_DARK = (254, 240, 138), (245, 158, 11), (180, 83, 9)

# Bolt silhouette, normalised 0..1
BOLT = [(0.57, 0.09), (0.27, 0.55), (0.47, 0.55), (0.37, 0.91), (0.75, 0.42), (0.54, 0.42), (0.71, 0.09)]


def vgradient(stops):
    """Vertical gradient through (position, colour) stops."""
    img = Image.new("RGB", (1, S))
    for y in range(S):
        t = y / (S - 1)
        for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
            if p0 <= t <= p1:
                k = (t - p0) / (p1 - p0)
                img.putpixel((0, y), tuple(int(c0[i] + (c1[i] - c0[i]) * k) for i in range(3)))
                break
    return img.resize((S, S))


def solid(colour):
    return Image.new("RGBA", (S, S), colour + (255,))


def build():
    # Tile: rounded square, charcoal -> black
    shape = Image.new("L", (S, S), 0)
    pad, radius = int(S * 0.04), int(S * 0.22)
    ImageDraw.Draw(shape).rounded_rectangle((pad, pad, S - pad, S - pad), radius, fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(vgradient([(0, (28, 25, 23)), (1, (5, 5, 5))]), mask=shape)

    # Bolt silhouette and its sound-bar cut
    bolt = Image.new("L", (S, S), 0)
    ImageDraw.Draw(bolt).polygon([(x * S, y * S) for x, y in BOLT], fill=255)
    bars = Image.new("L", (S, S), 0)
    pitch, gap = int(S * 0.04), int(S * 0.012)
    bd = ImageDraw.Draw(bars)
    for x in range(0, S, pitch):
        bd.rectangle((x, 0, x + pitch - gap, S), fill=255)
    cut = ImageChops.multiply(bolt, bars)

    # Warm glow behind the bolt
    glow = bolt.filter(ImageFilter.GaussianBlur(S * 0.05)).point(lambda v: int(v * 0.75))
    img = Image.composite(solid(GOLD), img, ImageChops.multiply(glow, shape))
    halo = Image.new("L", (S, S), 0)
    ImageDraw.Draw(halo).ellipse((S * 0.18, S * 0.18, S * 0.82, S * 0.82), fill=60)
    halo = halo.filter(ImageFilter.GaussianBlur(S * 0.12))
    img = Image.composite(solid(GOLD_DARK), img, ImageChops.multiply(halo, shape))

    # Gold bars, then a thin solid outline so the bolt reads at small sizes
    fill = vgradient([(0, GOLD_LIGHT), (0.5, GOLD), (1, GOLD_DARK)]).convert("RGBA")
    img = Image.composite(fill, img, cut)
    outline = ImageChops.subtract(bolt, bolt.filter(ImageFilter.MinFilter(int(S * 0.012) | 1)))
    img = Image.composite(fill, img, outline)

    img.putalpha(ImageChops.multiply(img.getchannel("A"), shape))
    return img.resize((1024, 1024), Image.LANCZOS)


if __name__ == "__main__":
    icon = build()
    icon.save(os.path.join(OUT, "icon.png"))
    icon.save(os.path.join(OUT, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote assets/icon.png and assets/icon.ico")
