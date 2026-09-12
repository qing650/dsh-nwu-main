# -*- coding: utf-8 -*-
"""问山 · 地形晕渲底图生成（站点无关）

从 AWS 开放高程瓦片（Terrarium 编码，SRTM 融合数据集）下载实习区 DEM，
重采样到等距圆柱投影（与前端照片地图一致），计算 Horn 山体阴影 + 高程
分层设色，合成一张明亮风格的地形底图：

    data/terrain.png    晕渲底图（RGB）
    data/terrain.json   元数据 {bounds, width, height, zoom}

用法：
    py -3.11 tools/build_terrain.py [config/<站点>.json]

仅依赖 pillow + numpy（安装问山时已随 GIS 依赖装入）。
"""
import io
import json
import math
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
CFG_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "config/lushan.json"
CFG = json.loads(CFG_PATH.read_text(encoding="utf-8"))
DATA = HERE.parent / CFG["paths"]["data"]

ZOOM = 13
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
PAD = 0.012          # 比矢量范围略外扩，平移地图时不露白边
SUN_AZ = 315.0       # 光源方位角（西北，制图惯例）
SUN_ALT = 45.0       # 光源高度角

# 高程分层设色（明亮纸质地图色系，低海拔偏绿、高海拔偏暖）
TINT_STOPS = [
    (0,    (233, 239, 224)),
    (150,  (223, 233, 207)),
    (400,  (210, 225, 188)),
    (700,  (200, 215, 170)),
    (1000, (197, 204, 155)),
    (1250, (206, 200, 151)),
    (1500, (220, 212, 174)),
]


def merc_y(lat: float, n: float) -> float:
    """纬度 -> Web Mercator 全球像素行（瓦片 256px 尺度）。"""
    rad = math.radians(lat)
    return (1 - math.asinh(math.tan(rad)) / math.pi) / 2 * n * 256


def merc_x(lon: float, n: float) -> float:
    return (lon + 180) / 360 * n * 256


def download_tiles(x0: int, x1: int, y0: int, y1: int) -> np.ndarray:
    """下载并拼接 Terrarium 瓦片，返回高程矩阵（米）。"""
    cols, rows = x1 - x0 + 1, y1 - y0 + 1
    mosaic = np.zeros((rows * 256, cols * 256), dtype=np.float32)
    total = cols * rows
    done = 0
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            url = TILE_URL.format(z=ZOOM, x=tx, y=ty)
            with urllib.request.urlopen(url, timeout=60) as resp:
                img = Image.open(io.BytesIO(resp.read())).convert("RGB")
            rgb = np.asarray(img, dtype=np.float32)
            elev = rgb[:, :, 0] * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768
            mosaic[(ty - y0) * 256:(ty - y0 + 1) * 256, (tx - x0) * 256:(tx - x0 + 1) * 256] = elev
            done += 1
            print(f"  瓦片 {done}/{total}  z{ZOOM}/{tx}/{ty}", flush=True)
    return mosaic


def bilinear_rows(src: np.ndarray, row_pos: np.ndarray, col_pos: np.ndarray) -> np.ndarray:
    """按给定的行/列亚像素位置做双线性重采样。"""
    r0 = np.clip(np.floor(row_pos).astype(int), 0, src.shape[0] - 2)
    c0 = np.clip(np.floor(col_pos).astype(int), 0, src.shape[1] - 2)
    wr = (row_pos - r0)[:, None]
    wc = (col_pos - c0)[None, :]
    a = src[r0][:, c0]
    b = src[r0][:, c0 + 1]
    c = src[r0 + 1][:, c0]
    d = src[r0 + 1][:, c0 + 1]
    return a * (1 - wr) * (1 - wc) + b * (1 - wr) * wc + c * wr * (1 - wc) + d * wr * wc


def hillshade(elev: np.ndarray, cellsize: float) -> np.ndarray:
    """Horn 山体阴影，返回 0..1。"""
    z = np.pad(elev, 1, mode="edge")
    dzdx = ((z[:-2, 2:] + 2 * z[1:-1, 2:] + z[2:, 2:])
            - (z[:-2, :-2] + 2 * z[1:-1, :-2] + z[2:, :-2])) / (8 * cellsize)
    dzdy = ((z[2:, :-2] + 2 * z[2:, 1:-1] + z[2:, 2:])
            - (z[:-2, :-2] + 2 * z[:-2, 1:-1] + z[:-2, 2:])) / (8 * cellsize)
    slope = np.arctan(np.hypot(dzdx, dzdy))
    aspect = np.arctan2(dzdy, -dzdx)
    az = math.radians(360.0 - SUN_AZ + 90.0)
    alt = math.radians(SUN_ALT)
    shade = (math.sin(alt) * np.cos(slope)
             + math.cos(alt) * np.sin(slope) * np.cos(az - aspect))
    return np.clip(shade, 0, 1)


def tint(elev: np.ndarray) -> np.ndarray:
    """高程分层设色，返回 (H,W,3) float 0..255。"""
    out = np.zeros(elev.shape + (3,), dtype=np.float32)
    stops = TINT_STOPS
    clipped = np.clip(elev, stops[0][0], stops[-1][0])
    for (e0, c0), (e1, c1) in zip(stops[:-1], stops[1:]):
        mask = (clipped >= e0) & (clipped <= e1)
        if not mask.any():
            continue
        t = (clipped[mask] - e0) / max(e1 - e0, 1e-9)
        for k in range(3):
            out[..., k][mask] = c0[k] + (c1[k] - c0[k]) * t
    return out


def main() -> None:
    map_meta = json.loads((DATA / "map_data.json").read_text(encoding="utf-8"))
    w, s, e, n = map_meta["bounds"]
    w, s, e, n = w - PAD, s - PAD, e + PAD, n + PAD
    tiles = 2 ** ZOOM
    x0, x1 = int(merc_x(w, tiles) // 256), int(merc_x(e, tiles) // 256)
    y0, y1 = int(merc_y(n, tiles) // 256), int(merc_y(s, tiles) // 256)
    print(f"== 地形晕渲：{CFG['site']['name']}  bounds={[round(v,4) for v in (w,s,e,n)]} ==")
    print(f"  下载 {(x1-x0+1)*(y1-y0+1)} 个高程瓦片（z{ZOOM}）")
    mosaic = download_tiles(x0, x1, y0, y1)

    mid_lat = (s + n) / 2
    m_per_px = 156543.034 / tiles * math.cos(math.radians(mid_lat))
    width = int(round((merc_x(e, tiles) - merc_x(w, tiles))))
    height = int(round((n - s) * 110540 / m_per_px))

    # Mercator 拼图 -> 等距圆柱输出网格（与前端投影一致）
    out_lats = n - (np.arange(height) + 0.5) / height * (n - s)
    row_pos = np.array([merc_y(lat, tiles) for lat in out_lats]) - y0 * 256
    col_pos = merc_x(w, tiles) - x0 * 256 + (np.arange(width) + 0.5) / width * (merc_x(e, tiles) - merc_x(w, tiles))
    elev = bilinear_rows(mosaic, row_pos, col_pos)

    shade = hillshade(elev, m_per_px)
    base = tint(elev)
    lit = base * (0.68 + 0.52 * shade[..., None])          # 阴影塑形
    lit += (shade[..., None] - 0.8).clip(0) * 90           # 向阳面提亮
    lit = lit * 0.94 + 255 * 0.06                          # 整体透气
    img = Image.fromarray(np.clip(lit, 0, 255).astype(np.uint8), "RGB")
    img.save(DATA / "terrain.png", optimize=True)
    (DATA / "terrain.json").write_text(json.dumps({
        "bounds": [round(v, 6) for v in (w, s, e, n)],
        "width": width,
        "height": height,
        "zoom": ZOOM,
        "source": "AWS Terrain Tiles (Terrarium, SRTM 等数据集融合)",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    kb = (DATA / "terrain.png").stat().st_size / 1024
    print(f"  高程范围 {elev.min():.0f}–{elev.max():.0f} m")
    print(f"  terrain.png {width}×{height}，{kb:.0f} KB")
    print("done")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
