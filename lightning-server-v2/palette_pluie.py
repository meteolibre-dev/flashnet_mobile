#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Palette précipitations 1h (mm) basée sur ébauche yann

"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple


Color = Tuple[int, int, int]


@dataclass(frozen=True)
class RainClass:
    threshold: float
    rgb: Color


# Seuils lus sur l'ébauche.
# Chaque couleur correspond à la classe commençant à "threshold".
# Exemple:
#   0.1 -> couleur pour [0.1, 0.2[
#   0.2 -> couleur pour [0.2, 0.5[
#   ...
#   125 -> couleur pour >= 125 mm
RAIN_CLASSES: List[RainClass] = [
#   RainClass(0.1,  (180, 215, 255)),
#   RainClass(0.2,  (117, 186, 255)),    
    RainClass(0.2,  (180, 215, 255)),  # #B4D7FF
    RainClass(0.5,  (90, 180, 255)),   # bleu clair plus lumineux
    RainClass(1.0,  (0, 140, 255)),    # bleu franc (plus saturé)
    RainClass(2.0,  (0, 90, 200)),     # bleu foncé
    RainClass(3.0,  (0, 54, 127)),
    RainClass(4.0,  (20, 143, 27)),
    RainClass(5.0,  (26, 207, 5)),
    RainClass(6.0,  (99, 237, 7)),
    RainClass(7.0,  (255, 244, 43)),
    RainClass(8.0,  (232, 220, 0)),
    RainClass(9.0,  (240, 96, 0)),
    RainClass(10.0, (255, 127, 39)),
    RainClass(12.0, (255, 166, 106)),
    RainClass(14.0, (248, 78, 120)),
    RainClass(16.0, (247, 30, 84)),
    RainClass(20.0, (191, 0, 0)),
    RainClass(24.0, (136, 0, 0)),
    RainClass(30.0, (100, 0, 127)),
    RainClass(40.0, (194, 0, 251)),
    RainClass(50.0, (221, 102, 255)),
    RainClass(60.0, (235, 166, 255)),
    RainClass(80.0, (249, 230, 255)),
    RainClass(100.0, (212, 212, 212)),
    RainClass(125.0, (150, 150, 150)),
]


def rgb_to_hex(rgb: Color) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def build_palette() -> Dict[str, str]:
    """Retourne le dictionnaire seuil -> couleur HEX."""
    return {format_threshold(c.threshold): rgb_to_hex(c.rgb) for c in RAIN_CLASSES}


def format_threshold(value: float) -> str:
    if int(value) == value:
        return str(int(value))
    return str(value).rstrip("0").rstrip(".")


def color_for_value(mm: float) -> Color:
    """Retourne la couleur de classe pour une valeur de pluie donnée."""
    if mm < 0.2:
        return (255,255,255,)#blanc

    current = RAIN_CLASSES[0].rgb
    for rc in RAIN_CLASSES:
        if mm >= rc.threshold:
            current = rc.rgb
        else:
            break
    return current


def save_palette_json(path: Path, palette: Dict[str, str]) -> None:
    path.write_text(json.dumps(palette, indent=2, ensure_ascii=False), encoding="utf-8")


def svg_rect(x: float, y: float, w: float, h: float, fill: str, stroke: str = "#ffffff") -> str:
    return (
        f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" '
        f'fill="{fill}" stroke="{stroke}" stroke-width="1" />'
    )


def svg_text(x: float, y: float, text: str, size: int = 12, anchor: str = "middle") -> str:
    safe = (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    return (
        f'<text x="{x:.2f}" y="{y:.2f}" font-family="Arial, Helvetica, sans-serif" '
        f'font-size="{size}" text-anchor="{anchor}" fill="#222">{safe}</text>'
    )


def save_palette_svg(path: Path, title: str = "Précipitations, 1h (mm)") -> None:
    """Exporte la palette sous forme de barre discrète SVG."""
    classes = [RainClass(0.0, (255, 255, 255))] + RAIN_CLASSES
    margin = 18
    cell_w = 28
    bar_h = 28
    width = margin * 2 + cell_w * len(classes)
    height = 120

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#f5f5f5" />',
        svg_text(width / 2, 20, title, size=18),
    ]

    x0 = margin
    y0 = 38

    # Barre colorée
    for i, rc in enumerate(classes):
        x = x0 + i * cell_w
        parts.append(svg_rect(x, y0, cell_w, bar_h, rgb_to_hex(rc.rgb), stroke="#999999"))

    # Labels alternés comme sur l'ébauche
    top_indices = set(i for i in range(len(classes)) if i % 2 == 1)
    for i, rc in enumerate(classes):
        x = x0 + i * cell_w
        parts.append(
            f'<line x1="{x:.2f}" y1="{y0:.2f}" x2="{x:.2f}" y2="{y0 - 6:.2f}" stroke="#444" stroke-width="1" />'
        )
        label = format_threshold(rc.threshold)
        if i in top_indices:
            parts.append(svg_text(x, y0 - 10, label, size=11))
        else:
            parts.append(svg_text(x, y0 + bar_h + 18, label, size=11))

    # Dernier repère à droite
    x_last = x0 + len(classes) * cell_w
    parts.append(
        f'<line x1="{x_last:.2f}" y1="{y0:.2f}" x2="{x_last:.2f}" y2="{y0 - 6:.2f}" stroke="#444" stroke-width="1" />'
    )
    parts.append(svg_text(x_last, y0 + bar_h + 18, format_threshold(classes[-1].threshold), size=11))

    # Petite légende
    legend_y = 104
    parts.append(svg_text(margin, legend_y, "Exemples :", size=11, anchor="start"))
    examples = [0.1, 5, 12, 40, 100]
    x_cursor = margin + 62
    for value in examples:
        hex_color = rgb_to_hex(color_for_value(value))
        parts.append(svg_rect(x_cursor, legend_y - 10, 16, 10, hex_color, stroke="#999999"))
        parts.append(svg_text(x_cursor + 20, legend_y - 1, f"{format_threshold(value)} mm = {hex_color}", size=11, anchor="start"))
        x_cursor += 122

    parts.append("</svg>")
    path.write_text("\n".join(parts), encoding="utf-8")


def print_palette_table() -> None:
    print("Palette précipitations 1h")
    print("-" * 36)
    for rc in RAIN_CLASSES:
        print(f">= {format_threshold(rc.threshold):>4} mm : {rgb_to_hex(rc.rgb)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Génère la palette pluie 1h à partir des classes visibles.")
    parser.add_argument("--svg", type=Path, default=Path("palette_pluie_1h.svg"), help="Nom du fichier SVG à produire")
    parser.add_argument("--json", type=Path, default=Path("palette_pluie_1h.json"), help="Nom du fichier JSON à produire")
    parser.add_argument("--no-json", action="store_true", help="Ne pas exporter le JSON")
    parser.add_argument("--no-svg", action="store_true", help="Ne pas exporter le SVG")
    args = parser.parse_args()

    palette = build_palette()
    print_palette_table()

    if not args.no_svg:
        save_palette_svg(args.svg)
        print(f"\nSVG écrit dans : {args.svg}")

    if not args.no_json:
        save_palette_json(args.json, palette)
        print(f"JSON écrit dans : {args.json}")


if __name__ == "__main__":
    main()
