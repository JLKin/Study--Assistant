"""Render synthetic OCR fixtures only; never use a platform screenshot or retained question."""
import argparse
import hashlib
import json
import pathlib
import re

from PIL import Image, ImageDraw, ImageFont


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--font", required=True)
    args = parser.parse_args()
    directory = pathlib.Path(__file__).resolve().parent
    source = json.loads((directory / "cases.json").read_text(encoding="utf-8"))
    assert source["syntheticOnly"] is True
    font = ImageFont.truetype(args.font, 44)
    for case in source["cases"]:
        assert re.fullmatch(r"[a-z]+", case["id"])
        image = Image.new("RGB", (1200, max(560, len(case["lines"]) * 100 + 60)), "white")
        drawing = ImageDraw.Draw(image)
        for index, line in enumerate(case["lines"]):
            drawing.text((45, 30 + index * 100), line, font=font, fill="black")
        image.save(directory / (case["id"] + ".png"))
    print(json.dumps({"syntheticImages": len(source["cases"]), "fontSha256": hashlib.sha256(pathlib.Path(args.font).read_bytes()).hexdigest()}))


if __name__ == "__main__":
    main()
