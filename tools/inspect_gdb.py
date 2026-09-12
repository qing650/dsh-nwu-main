# -*- coding: utf-8 -*-
"""GDB 结构探测器 —— 接一个新实习区时先跑这个，再照着输出填 config/<站点>.json。

换实习区最容易卡住的地方不是代码，而是"这份 GDB 的图层叫什么、字段叫什么"。
这个脚本把图层清单、几何类型、要素数、字段名和取值样例打出来，
并对常见专题（地质/土壤/植被/断层/道路/水系/山峰/景点）给出猜测映射，可直接粘进配置。

用法：
    python tools/inspect_gdb.py <路径.gdb>              # 概览
    python tools/inspect_gdb.py <路径.gdb> 地质分区       # 单个图层详情
    python tools/inspect_gdb.py <路径.gdb> --guess       # 输出猜测的配置片段
"""
import json
import sys
from collections import Counter

import fiona

sys.stdout.reconfigure(encoding="utf-8")

if len(sys.argv) < 2:
    sys.exit(__doc__)
GDB = sys.argv[1]
ARG = sys.argv[2] if len(sys.argv) > 2 else None

LAYERS = fiona.listlayers(GDB)


def profile(layer, sample=400):
    """返回 (几何类型, 要素数, {字段: [样例…]})"""
    with fiona.open(GDB, layer=layer) as src:
        gtype = src.schema.get("geometry", "?")
        fields = list(src.schema.get("properties", {}).keys())
        n = len(src)
        vals = {f: [] for f in fields}
        for i, feat in enumerate(src):
            if i >= sample:
                break
            for f in fields:
                v = feat["properties"].get(f)
                if v not in (None, "") and len(vals[f]) < 3:
                    s = str(v).strip().replace("\n", " ")
                    if s and s not in vals[f]:
                        vals[f].append(s[:28])
    return gtype, n, vals


# —— 单图层详情 ——
if ARG and not ARG.startswith("--"):
    if ARG not in LAYERS:
        sys.exit(f"图层 {ARG} 不存在。可用图层：\n" + "\n".join("  " + x for x in LAYERS))
    gtype, n, vals = profile(ARG)
    print(f"图层 {ARG}   几何 {gtype}   要素 {n}\n")
    for f, s in vals.items():
        print(f"  {f:22s} {' | '.join(s) if s else '(全空)'}")
    sys.exit(0)

# —— 概览 ——
print(f"GDB: {GDB}\n共 {len(LAYERS)} 个图层\n")
prof = {}
print(f"{'图层':26s} {'几何':14s} {'要素':>7s}  字段")
print("-" * 100)
for lyr in LAYERS:
    try:
        gtype, n, vals = profile(lyr, sample=60)
    except Exception as e:
        print(f"{lyr:26s} !! 打不开：{e}")
        continue
    prof[lyr] = (gtype, n, vals)
    fields = ", ".join(list(vals.keys())[:6])
    print(f"{lyr:26s} {str(gtype):14s} {n:7d}  {fields}")

if ARG != "--guess":
    print("\n看某个图层的字段取值：python tools/inspect_gdb.py <gdb> <图层名>")
    print("生成配置片段：      python tools/inspect_gdb.py <gdb> --guess")
    sys.exit(0)

# —— 猜测配置片段 ——
KEY = {
    "areaLayer": ["实习区域", "研究区", "范围", "study", "area", "boundary"],
    "geologyLayer": ["地质分区", "地质", "geolog"],
    "faultLayer": ["断层", "fault"],
    "foldLayer": ["轴迹", "褶皱", "fold"],
    "attitudeLayer": ["产状", "attitude", "strike"],
    "soilLayer": ["土壤", "soil"],
    "vegLayer": ["植被", "veget"],
    "riverLineLayer": ["水系_线", "河流_线", "river"],
    "waterNoteLayer": ["水利要素及其附属设施_注记", "水系_注记", "水利.*注记"],
}
POLY = {"Polygon", "MultiPolygon"}
LINE = {"LineString", "MultiLineString"}
POINT = {"Point", "MultiPoint", "3D Point"}


def pick(cands, want_geom=None):
    best = None
    for lyr, (gtype, n, _) in prof.items():
        if want_geom and gtype not in want_geom:
            continue
        for i, kw in enumerate(cands):
            if kw in lyr:
                score = (-i, n)          # 关键词越靠前越优先，其次要素多的
                if best is None or score > best[0]:
                    best = (score, lyr)
    return best[1] if best else None


guess = {}
for key, kws in KEY.items():
    geom = POLY if key in ("areaLayer", "geologyLayer", "soilLayer", "vegLayer") else None
    if key in ("faultLayer", "foldLayer", "attitudeLayer", "riverLineLayer"):
        geom = LINE
    if key == "waterNoteLayer":
        geom = POINT
    got = pick(kws, geom)
    if got:
        guess[key] = got

# 面状水体、道路、山峰、景点：多来源
guess["water"] = [{"layer": l, "tol": 8e-05} for l, (g, n, _) in prof.items()
                  if g in POLY and any(k in l for k in ("水系_面", "湖泊", "河流_region"))]
guess["roads"] = [{"layer": l, "rank": "road", "tol": 1.2e-04}
                  for l, (g, n, _) in prof.items()
                  if g in LINE and any(k in l for k in ("公路", "国道", "省道", "县道", "道路", "road"))]


def name_field(layer):
    """猜哪个字段是名称：字段名含 name/名称，且取值多为短中文"""
    if layer not in prof:
        return None
    _, _, vals = prof[layer]
    for f in vals:
        if f.lower() in ("name", "名称") or "name" in f.lower() or "名" in f:
            return f
    return next(iter(vals), None)


guess["peaks"] = [{"layer": l, "field": name_field(l)} for l, (g, n, _) in prof.items()
                  if g in POINT and any(k in l for k in ("山峰", "山_", "peak"))]
guess["pois"] = [{"layer": l, "field": name_field(l), "kind": "scenic"}
                 for l, (g, n, _) in prof.items()
                 if g in POINT and any(k in l for k in ("景点", "景区", "poi"))]
guess["gazLayers"] = [{"layer": l, "field": name_field(l)} for l, (g, n, _) in prof.items()
                      if g in POINT and any(k in l for k in ("山峰", "山_", "景点", "乡镇", "驻地", "居民地_点"))]

print("\n" + "=" * 60)
print('猜测的 "gdb" 配置片段（务必人工核对字段名，尤其是各专题的属性字段）：')
print("=" * 60)
print(json.dumps({"gdb": guess}, ensure_ascii=False, indent=2))
print("\n还需人工确认的：")
print("  · gdb.geologyFields  地质图层里「系纪/地层符号/群组段期/描述/变质程度/岩类/界代」各自的字段名")
print("  · gdb.soilField / gdb.vegField   土壤类型名、优势树种字段名")
print("  · eraNorm.rename     该区地层年代的异名归并（如 早三叠世→三叠纪）")
print("  · soilGroups         该区出现的土壤大类清单")
print("  · gazetteer          GDB 里没有、但笔记里会提到的地名（手工点位/沿线插值/锚点偏移）")
