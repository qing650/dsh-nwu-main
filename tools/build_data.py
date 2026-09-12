# -*- coding: utf-8 -*-
"""
地理现场（旧庐山）示例数据管线（站点无关，教务问答不再使用；保留用于兼容旧数据重建）
把三类数据源编译为前端 JSON：
  1) <站点>.gdb        -> map_data.json   (简化后的专题 GeoJSON)
  2) Obsidian 知识库    -> graph_data.json (知识图谱节点+链接+笔记正文)
  3) 每日整理/<日期>    -> days_data.json  (行程时间线) + photos_index.json + photos/*.jpg
  4) 站点配置          -> site_data.json  (前端文案 / 示例问题 / 演示锚点)

用法：
    python tools/build_data.py [config/<站点>.json]
不传参数时默认 config/lushan.json。换一个实习区只需新写一份配置，代码不用改。
"""
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import fiona
from PIL import Image, ImageOps
from shapely.geometry import shape, mapping, box
from shapely.ops import unary_union

sys.stdout.reconfigure(encoding="utf-8")

# ---------------------------------------------------------------- 配置

HERE = Path(__file__).resolve().parent
CFG_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "config/lushan.json"
if not CFG_PATH.exists():
    sys.exit(f"找不到站点配置：{CFG_PATH}")
CFG = json.loads(CFG_PATH.read_text(encoding="utf-8"))
print(f"== 站点配置：{CFG_PATH.name}（{CFG['site']['name']}）==")

P = CFG["paths"]
GDB = P["gdb"]
VAULT = Path(P["vault"])
DAILY = Path(P["daily"])
OUT = Path(P["data"])
PHOTO_DIR = OUT / "photos"
OUT.mkdir(parents=True, exist_ok=True)
PHOTO_DIR.mkdir(parents=True, exist_ok=True)

G = CFG["gdb"]
PH = CFG["photo"]
PHOTO_MAX = PH["maxEdge"]
PHOTO_Q = PH["quality"]
PHOTO_CAP_POINT = PH["capPerPoint"]
PHOTO_CAP_ROAD = PH["capRoadside"]
MD_MAX = CFG["note"]["mdMaxChars"]
VC = CFG["vault"]

# ---------------------------------------------------------------- 工具


def rnd(coords, nd=5):
    if isinstance(coords, (float, int)):
        return round(coords, nd)
    return [rnd(c, nd) for c in coords]


def geom_to_json(geom, nd=5):
    gj = mapping(geom)
    return {"type": gj["type"], "coordinates": rnd(gj["coordinates"], nd)}


def simp(geom, tol):
    g = geom.simplify(tol, preserve_topology=True)
    return g if not g.is_empty else None


def read_layer(layer):
    """读图层；图层不存在时跳过而非崩溃（换站点时 GDB schema 可能缺项）"""
    try:
        src = fiona.open(GDB, layer=layer)
    except Exception as e:
        print(f"  ! 跳过图层 {layer}: {e}")
        return
    with src:
        for f in src:
            g = f["geometry"]
            if g is None:
                continue
            try:
                yield shape(g), dict(f["properties"])
            except Exception:
                continue


def sv(props, key):
    v = props.get(key)
    if v is None:
        return ""
    return str(v).strip()

# ---------------------------------------------------------------- 1. 地图数据

with fiona.open(GDB, layer=G["areaLayer"]) as src:
    AREA_BOUNDS = src.bounds
PAD = G.get("pad", 0.015)
BBOX = box(AREA_BOUNDS[0] - PAD, AREA_BOUNDS[1] - PAD,
           AREA_BOUNDS[2] + PAD, AREA_BOUNDS[3] + PAD)


def clipped(layer, tol, keep=None, min_area=0.0):
    """读取图层，按 bbox 裁剪 + 简化，keep(props)->attrs 或 None 表示跳过"""
    feats = []
    for geom, props in read_layer(layer):
        if not geom.is_valid:
            geom = geom.buffer(0)
        if geom.is_empty or not geom.intersects(BBOX):
            continue
        attrs = keep(props) if keep else {}
        if attrs is None:
            continue
        g = geom.intersection(BBOX)
        if min_area and g.area < min_area:
            continue
        g = simp(g, tol)
        if g is None or g.is_empty:
            continue
        feats.append({"g": geom_to_json(g), "p": attrs})
    return feats


GF = G.get("geologyFields", {})
F_ERA = GF.get("era", "系纪")
F_SYMBOL = GF.get("symbol", "地层符号")
F_GROUP = GF.get("group", "群组段期")
F_DESC = GF.get("desc", ["描述", "描述1"])
F_META = GF.get("metamorphic", "变质程度")
F_ROCK = GF.get("rockClass", "岩类")
F_ERATHEM = GF.get("erathem", "界代")
EN = CFG.get("eraNorm", {})
ERA_RENAME = EN.get("rename", {})
ERA_INTRUSIVE = EN.get("intrusiveWhenBlank", {})


def era_norm(props):
    e = sv(props, F_ERA)
    if e in ERA_RENAME:
        return ERA_RENAME[e]
    if not e:
        rc = ERA_INTRUSIVE.get("rockClassContains", "")
        pre = tuple(ERA_INTRUSIVE.get("symbolStartsWith", []))
        if (rc and rc in sv(props, F_ROCK)) or (pre and sv(props, F_SYMBOL).startswith(pre)):
            return ERA_INTRUSIVE.get("label", "岩浆侵入体")
        return sv(props, F_ERATHEM) or "未定"
    return e


def build_map():
    layers = {}

    # 研究区边界
    feats = []
    for geom, _ in read_layer(G["areaLayer"]):
        feats.append({"g": geom_to_json(simp(geom, 2e-4)), "p": {}})
    layers["boundary"] = feats

    # 水体（面）
    named_lakes = {}
    for geom, props in read_layer(G["waterNoteLayer"]):
        n = sv(props, G["waterNoteField"])
        if n and len(n) >= 3:
            c = geom.centroid
            named_lakes[n] = (c.x, c.y)
    water = []
    for spec in G["water"]:
        for f in clipped(spec["layer"], spec["tol"], min_area=2e-9):
            water.append(f)
    # 给面要素挂湖名
    from shapely.geometry import Point as SPoint, shape as sshape
    for f in water:
        try:
            g = sshape({"type": f["g"]["type"], "coordinates": f["g"]["coordinates"]})
            for n, (x, y) in named_lakes.items():
                if n.endswith(("水库", "湖")) and g.contains(SPoint(x, y)):
                    f["p"]["n"] = n
                    break
        except Exception:
            pass
    layers["water"] = water

    # 河流（线）
    layers["rivers"] = clipped(
        G["riverLineLayer"], 8e-5,
        keep=lambda p: ({"n": sv(p, "名称")} if "河流" in sv(p, "编码名称") else None))

    # 道路
    roads = []
    for spec in G["roads"]:
        for f in clipped(spec["layer"], spec["tol"]):
            f["p"]["r"] = spec["rank"]
            roads.append(f)
    layers["roads"] = roads

    # 地质分区（含沉积岩/岩浆岩/侵入岩的统一分区）
    def geo_keep(p):
        desc = ""
        for k in F_DESC:
            desc = desc or sv(p, k)
        return {
            "s": sv(p, F_SYMBOL),
            "e": era_norm(p),
            "n": sv(p, F_GROUP),
            "d": desc[:300],
            "m": sv(p, F_META),
        }
    layers["geology"] = clipped(G["geologyLayer"], 6e-5, keep=geo_keep)

    # 断层 / 褶皱轴迹 / 产状
    layers["faults"] = clipped(
        G["faultLayer"], 5e-5,
        keep=lambda p: {"n": sv(p, "断层名称"), "t": sv(p, "断层类型"),
                        "f": sv(p, "特征"), "a": sv(p, "活动时期")})

    def fold_keep(p):
        n = sv(p, "褶皱名称")
        return {"n": n, "a": sv(p, "褶皱轴向"),
                "k": "syn" if "向斜" in n else "anti"}
    layers["folds"] = clipped(G["foldLayer"], 5e-5, keep=fold_keep)
    layers["attitude"] = clipped(
        G["attitudeLayer"], 0,
        keep=lambda p: {"d": sv(p, "倾向方向"), "a": sv(p, "倾角"),
                        "t": sv(p, "产状类型")})

    # 土壤
    soil_groups = CFG.get("soilGroups", [])

    def soil_group(name):
        for g in soil_groups:
            if g in name:
                return g
        return "其他"
    layers["soil"] = clipped(
        G["soilLayer"], 8e-5,
        keep=lambda p: {"n": sv(p, G["soilField"]), "g": soil_group(sv(p, G["soilField"]))})

    # 植被（按优势树种融合）
    veg_groups = defaultdict(list)
    for geom, props in read_layer(G["vegLayer"]):
        if not geom.intersects(BBOX):
            continue
        k = sv(props, G["vegField"]) or "未知"
        veg_groups[k].append(geom.buffer(0))
    veg = []
    for k, gs in veg_groups.items():
        try:
            u = unary_union(gs).intersection(BBOX)
            u = simp(u, 1.2e-4)
            if u is None or u.is_empty:
                continue
            if u.geom_type == "Polygon":
                polys = [u]
            else:
                polys = [g for g in u.geoms if g.geom_type == "Polygon" and g.area > 3e-8]
            for g in polys:
                veg.append({"g": geom_to_json(g), "p": {"n": k}})
        except Exception as e:
            print("  veg skip", k, e)
    layers["vegetation"] = veg

    # 山峰（可合并多个来源）
    peaks, seen = [], set()
    for spec in G["peaks"]:
        for geom, props in read_layer(spec["layer"]):
            n = sv(props, spec["field"])
            if n and n not in seen and geom.within(BBOX):
                seen.add(n)
                peaks.append({"n": n, "x": round(geom.x, 5), "y": round(geom.y, 5)})
    layers["peaks"] = peaks

    # 地名兴趣点
    pois = []
    for spec in G["pois"]:
        skip = set(spec.get("skip", []))
        for geom, props in read_layer(spec["layer"]):
            n = sv(props, spec["field"]) or spec.get("fallback", "")
            if not n or n in skip:
                continue
            if not spec.get("fallback") and not geom.within(BBOX):
                continue
            pois.append({"n": n, "x": round(geom.x, 5), "y": round(geom.y, 5),
                         "k": spec["kind"]})
    layers["pois"] = pois

    return layers, named_lakes

# ---------------------------------------------------------------- 2. 地名坐标（讲解点 / 地点笔记定位用）


def build_gazetteer(named_lakes):
    gaz = {}
    GZ = CFG.get("gazetteer", {})

    def put(n, x, y, approx=False):
        if n and n not in gaz:
            gaz[n] = {"x": round(x, 6), "y": round(y, 6), "approx": approx}

    for spec in G["gazLayers"]:
        for geom, props in read_layer(spec["layer"]):
            put(sv(props, spec["field"]), geom.x, geom.y)
    for n, (x, y) in named_lakes.items():
        put(n, x, y)

    # 常用别名 -> 数据库名
    for a, t in GZ.get("alias", {}).items():
        if t in gaz:
            gaz.setdefault(a, gaz[t])

    # —— manifest 实测坐标（GPS），同时作为地点锚点 ——
    for short, anchors in GZ.get("manifestAnchors", {}).items():
        mf = DAILY / short / "manifest.json"
        if not mf.exists():
            continue
        man = json.loads(mf.read_text(encoding="utf-8"))
        pts = {}
        for k, v in man.items():
            for r in v.get("records", []):
                c = r.get("coord")
                if c:
                    x, y = [float(t) for t in c.split(",")]
                    pts[str(k)] = (x, y)
        for idx, name in anchors.items():
            if str(idx) in pts:
                put(name, *pts[str(idx)])

    # —— 绝对手工点位 ——
    for p in GZ.get("points", []):
        put(p["n"], p["x"], p["y"], p.get("approx", False))

    # —— 两锚点之间的沿线插值 ——
    for seg in GZ.get("interpolated", []):
        a, b = seg["from"], seg["to"]
        if a not in gaz or b not in gaz:
            continue
        A, B = gaz[a], gaz[b]
        for p in seg["points"]:
            t = p["t"]
            put(p["n"],
                A["x"] + (B["x"] - A["x"]) * t + p.get("dx", 0.0),
                A["y"] + (B["y"] - A["y"]) * t + p.get("dy", 0.0),
                approx=True)

    # —— 相对某锚点的偏移 ——
    for grp in GZ.get("offsets", []):
        a = grp["from"]
        if a not in gaz:
            continue
        A = gaz[a]
        for p in grp["points"]:
            put(p["n"], A["x"] + p.get("dx", 0.0), A["y"] + p.get("dy", 0.0), approx=True)

    return gaz

# ---------------------------------------------------------------- 3. 知识库 -> 图谱

FM_RE = re.compile(r"^---\n(.*?)\n---\n", re.S)
LINK_RE = re.compile(r"\[\[([^\]]+?)\]\]")


def parse_front(md):
    m = FM_RE.match(md)
    if not m:
        return {}, md
    fm, body = m.group(1), md[m.end():]
    data, last = {}, None
    for line in fm.splitlines():
        mm = re.match(r"^([A-Za-z一-鿿_][^:]*):\s*(.*)$", line)
        if mm:
            k, v = mm.group(1).strip(), mm.group(2).strip()
            if v == "":
                data[k] = []
                last = k
            else:
                data[k] = v
                last = None
        elif last is not None:
            mm2 = re.match(r"^\s*-\s*(.*)$", line)
            if mm2:
                data[last].append(mm2.group(1).strip().strip('"'))
    return data, body


def link_target(raw):
    raw = raw.replace(r"\|", "|")
    return raw.split("|")[0].split("#")[0].strip()


def build_graph(gaz, points_coord, venue_coord, photos):
    notes = {}
    skip = set(VC.get("skipFolders", []))
    for p in VAULT.rglob("*.md"):
        rel = p.relative_to(VAULT)
        if rel.parts[0] in skip:
            continue
        folder = rel.parts[0] if len(rel.parts) > 1 else "索引"
        md = p.read_text(encoding="utf-8")
        fm, body = parse_front(md)
        stem = p.stem
        notes[stem] = {"stem": stem, "folder": folder, "fm": fm, "body": body}

    alias_map = {}
    for stem, n in notes.items():
        alias_map[stem] = stem
        al = n["fm"].get("aliases", [])
        if isinstance(al, list):
            for a in al:
                alias_map.setdefault(a, stem)

    # 链接（只保留能解析到真实笔记的）
    for stem, n in notes.items():
        outs = set()
        for m in LINK_RE.finditer(n["body"]):
            t = link_target(m.group(1))
            if t.startswith("附件") or "/" in t:
                continue
            if t in alias_map and alias_map[t] != stem:
                outs.add(alias_map[t])
        n["out"] = sorted(outs)

    nodes = []
    type_of = {"主线": "主线", "地点": "地点", "概念": "概念", "每日": "每日",
               "气象": "气象", "物种": "物种", "讲解点": "讲解点", "索引": "索引"}

    def photo_tokens(body, date):
        dd = date.replace("-", "")[4:] if date else ""

        def rep(m):
            inner = m.group(1)
            mm = re.search(r"讲解点照片/讲解点(\d+)[^/\]]*/([^/\]]+)\.(?:png|jpe?g)$", inner, re.I)
            if mm and dd:
                n, base = mm.group(1), mm.group(2)
                for pid in (f"{dd}-jd{n}-{base}",):
                    if pid in photos:
                        return "{{photo:%s}}" % pid
                m2 = re.search(r"_(\d+)$", base)
                if m2:
                    pid = f"{dd}-jd{n}-{m2.group(1)}"
                    if pid in photos:
                        return "{{photo:%s}}" % pid
            return ""
        return re.sub(r"!\[\[([^\]]+?)\]\]", rep, body)

    for stem, n in notes.items():
        fm = n["fm"]
        kind = fm.get("type") or type_of.get(n["folder"], n["folder"])
        date = str(fm.get("date", ""))
        body = photo_tokens(n["body"], date)
        node = {"id": stem, "k": kind, "out": n["out"],
                "md": body[:MD_MAX]}
        title = stem
        m = re.match(r"^(\d{4})-(\d+)\s+(.*)$", stem)
        if kind == "讲解点" and m:
            node["day"] = f"{int(m.group(1)[:2])}.{int(m.group(1)[2:])}"
            node["n"] = int(m.group(2))
            title = m.group(3)
        node["t"] = title
        if fm.get("海拔"):
            node["alt"] = fm["海拔"]
        if fm.get("时间"):
            node["time"] = fm["时间"]
        if date:
            node["date"] = date
        # 坐标：讲解点用行程坐标；地点优先用地名表，
        # 地名表里没有的（GDB 与手工配置都未收录）继承"在该地点讲过的讲解点"的坐标
        if stem in points_coord:
            node["c"] = points_coord[stem]
        elif kind == "地点" and stem in gaz:
            node["c"] = [gaz[stem]["x"], gaz[stem]["y"]]
        elif kind == "地点" and stem in venue_coord:
            node["c"] = venue_coord[stem]
        nodes.append(node)
    return nodes

# ---------------------------------------------------------------- 4. 每日行程


def save_photo(src, pid):
    """压缩并写入 data/photos/<pid>.jpg。返回是否成功。
    （早期版本把照片 base64 内嵌进单文件 HTML，那是 Artifact 单文件约束的产物；
      标准前后端下照片走普通静态文件，浏览器可缓存，首屏不必解析 5 MB base64。）"""
    try:
        im = Image.open(src)
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        im.thumbnail((PHOTO_MAX, PHOTO_MAX))
        im.save(PHOTO_DIR / f"{pid}.jpg", "JPEG",
                quality=PHOTO_Q, optimize=True, progressive=True)
        return True
    except Exception as e:
        print("  photo fail", src, e)
        return False


def clean_caption(c):
    c = re.sub(r"（\d+）\s*$", "", c or "").strip()
    return c[:120]


def md_section(body, names):
    """取 '## name' 小节原文（标题允许带后缀，如 '数据（按海拔降序）'）"""
    for name in names:
        m = re.search(rf"^##\s+{re.escape(name)}[^\n]*$(.*?)(?=^##\s|\Z)",
                      body, re.S | re.M)
        if m:
            return m.group(1).strip()
    return ""


def strip_links_text(md):
    md = re.sub(r"\[\[([^\]|]*?)\|([^\]]*?)\]\]", r"\2", md)
    md = re.sub(r"\[\[([^\]]*?)\]\]", r"\1", md)
    return re.sub(r"[*_`>#]", "", md).strip()


def split_row(line):
    """按 | 切分单元格，正确处理 wikilink 里的转义 \\|"""
    line = line.strip().strip("|").replace(r"\|", "\x02")
    return [c.strip().replace("\x02", "|") for c in line.split("|")]


def parse_md_table(sec, with_header=False):
    rows = []
    for line in sec.splitlines():
        line = line.strip()
        if not line.startswith("|") or re.match(r"^\|[\s:\-|]+\|$", line):
            continue
        rows.append(split_row(line))
    if with_header:
        return rows
    return rows[1:] if rows else []   # 去表头


def parse_weather(date):
    p = VAULT / VC["weatherPath"].format(date=date)
    if not p.exists():
        return None
    fm, body = parse_front(p.read_text(encoding="utf-8"))
    head = body.split("\n## ")[0]
    paras = [t.strip() for t in head.split("\n\n")
             if t.strip() and not t.strip().startswith("#")]
    intro = strip_links_text(paras[0]) if paras else ""

    sec = md_section(body, ["实测数据", "数据"])
    table = parse_md_table(sec, with_header=True)
    if not table:                       # 表格直接在正文，无小节标题
        table = parse_md_table(body, with_header=True)
    rows = []
    if table:
        header = table[0]

        def col(*keys):
            for i, h in enumerate(header):
                if any(k in h for k in keys):
                    return i
            return None
        ci = {k: col(*ks) for k, ks in {
            "loc": ("测点",), "rel": ("关联",), "time": ("时刻", "时间"),
            "alt": ("高程", "海拔"), "P": ("气压",), "T": ("气温",),
            "RH": ("湿度",), "dew": ("露点",), "e": ("水汽压",),
            "theta": ("位温",), "wd": ("风向",), "ws": ("风速",)}.items()}
        # "气压高程/m" 列会抢先匹配"气压"——重定位到真正的气压列
        if ci["P"] is not None and "高程" in header[ci["P"]]:
            for i, h in enumerate(header):
                if "气压" in h and "高程" not in h:
                    ci["P"] = i
                    break
        for cells in table[1:]:
            def get(k):
                i = ci.get(k)
                return cells[i] if i is not None and i < len(cells) else ""
            loc = strip_links_text(
                re.sub(r"^地点\s*\d+", "", get("loc")).replace("　", " ")).strip()
            mpt = re.search(r"讲解点\s*(\d+)", get("rel") or "")
            rows.append({
                "loc": loc, "pt": int(mpt.group(1)) if mpt else None,
                "time": get("time"), "alt": get("alt"), "P": get("P"),
                "T": get("T"), "RH": get("RH"), "dew": get("dew"),
                "e": get("e"), "theta": get("theta"),
                "wd": get("wd"), "ws": get("ws")})
    fit = None
    m = re.search(r"P\s*=\s*([\d.]+)\s*[−\-]\s*([\d.]+)\s*H", body)
    r2 = re.search(r"r²\s*=\s*([\d.]+)", body)
    if m:
        fit = {"a": float(m.group(1)), "b": float(m.group(2)),
               "r2": float(r2.group(1)) if r2 else None}
    return {"intro": intro[:220], "rows": rows, "fit": fit,
            "noteId": p.stem}


def build_days(gaz):
    photos = {}
    points_coord = {}
    venue_coord = {}       # 地点名 -> 该地点上某个讲解点的坐标（地名表兜底用）
    days = []

    day_notes = sorted(VAULT.glob(VC["dayGlob"]))
    for dn in day_notes:
        date = dn.stem                       # 2026-07-10
        mmdd = date[5:].replace("-", "")     # 0710
        short = f"{int(date[5:7])}.{int(date[8:10])}"
        folder = DAILY / short
        fm, body = parse_front(dn.read_text(encoding="utf-8"))

        # —— manifest / mapping（若有） ——
        man, mapg = {}, {}
        if (folder / "manifest.json").exists():
            man = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        if (folder / "mapping.json").exists():
            mapg = json.loads((folder / "mapping.json").read_text(encoding="utf-8")).get("映射", {})
        pos_of_point = {}                    # 讲解点序号 -> 点位号
        for pos, s in mapg.items():
            pos_of_point[int(s)] = int(re.sub(r"\D", "", pos))
        wx = parse_weather(date)

        # —— 讲解点 ——
        pts = []
        for pn in sorted(VAULT.glob(VC["pointGlob"].format(mmdd=mmdd))):
            pfm, pbody = parse_front(pn.read_text(encoding="utf-8"))
            n = int(pfm.get("序号", re.match(r"^\d{4}-(\d+)", pn.stem).group(1)))
            title = re.sub(r"^\d{4}-\d+\s*", "", pn.stem)
            center = strip_links_text(md_section(pbody, ["讲解中心"]))[:180]
            # 场所：时空定位 callout 里的第一个地点链接
            venue, vid = "", None
            mcall = re.search(r">\s*\[!\w+\][^\n]*\n((?:>[^\n]*\n?)+)", pbody)
            if mcall:
                for lm in LINK_RE.finditer(mcall.group(1)):
                    t = link_target(lm.group(1))
                    if (VAULT / VC["placeFolder"] / (t + ".md")).exists():
                        venue, vid = t, t
                        break
            # 坐标
            coord = None
            if n in pos_of_point and str(pos_of_point[n]) in man:
                recs = man[str(pos_of_point[n])].get("records") or []
                rec = recs[0] if recs else None
                if rec and rec.get("coord"):
                    x, y = [float(t) for t in rec["coord"].split(",")]
                    coord = [round(x, 6), round(y, 6)]
            if coord is None and venue and venue in gaz:
                coord = [gaz[venue]["x"], gaz[venue]["y"]]
            if coord:
                points_coord[pn.stem] = coord

            # 照片
            pids = []
            if n in pos_of_point and str(pos_of_point[n]) in man:      # manifest 来源
                figs = man[str(pos_of_point[n])].get("figs", [])[:PHOTO_CAP_POINT]
                for i, f in enumerate(figs, 1):
                    src = f.get("small")
                    if not src or not Path(src).exists():
                        continue
                    pid = f"{mmdd}-jd{n}-{i}"
                    if save_photo(src, pid):
                        photos[pid] = {"c": clean_caption(f.get("caption")),
                                       "t": f.get("time", "")}
                        pids.append(pid)
            else:                                                       # 文件夹来源
                pdirs = list(folder.glob(f"**/讲解点照片/讲解点{n}_*/"))
                if pdirs:
                    imgs = sorted([f for f in pdirs[0].iterdir()
                                   if f.suffix.lower() in (".png", ".jpg", ".jpeg")])
                    for f in imgs[:PHOTO_CAP_POINT]:
                        mm2 = re.match(r"(\d{3,4})_(.+?)_\d+", f.stem)
                        cap = mm2.group(2) if mm2 else f.stem
                        tt = mm2.group(1) if mm2 else ""
                        tt = f"{tt[:-2]}:{tt[-2:]}" if len(tt) >= 3 else ""
                        pid = f"{mmdd}-jd{n}-{f.stem}"
                        if save_photo(f, pid):
                            photos[pid] = {"c": clean_caption(cap), "t": tt}
                            pids.append(pid)

            wrow = None
            if wx:
                for i, r in enumerate(wx["rows"]):
                    if r["pt"] == n:
                        wrow = i
                        break
            pts.append({"n": n, "id": pn.stem, "title": title,
                        "time": str(pfm.get("时间", "")), "alt": pfm.get("海拔", ""),
                        "venue": venue, "venueId": vid, "coord": coord,
                        "approx": bool(venue and coord and gaz.get(venue, {}).get("approx")),
                        "center": center, "photos": pids, "wx": wrow})
        pts.sort(key=lambda p: p["n"])

        # 无坐标的点：沿路线用前后点插值兜底
        for i, p in enumerate(pts):
            if p["coord"]:
                points_coord[p["id"]] = p["coord"]
                continue
            prev = next((q["coord"] for q in reversed(pts[:i]) if q["coord"]), None)
            nxt = next((q["coord"] for q in pts[i + 1:] if q["coord"]), None)
            if prev and nxt:
                p["coord"] = [round((prev[0] + nxt[0]) / 2, 6),
                              round((prev[1] + nxt[1]) / 2, 6)]
            elif prev or nxt:
                p["coord"] = prev or nxt
            if p["coord"]:
                p["approx"] = True
                points_coord[p["id"]] = p["coord"]

        # 讲解点场所 -> 坐标（同名场所取第一个有坐标的）
        for p in pts:
            if p["venue"] and p["coord"] and p["venue"] not in venue_coord:
                venue_coord[p["venue"]] = p["coord"]

        # —— 沿途照片（每组 1 张） ——
        road_pids = []
        rdirs = [d for d in [folder / "沿途照片"] if d.exists()]
        rdirs += [d for d in folder.glob("**/沿途照片") if d not in rdirs]
        groups = {}
        for d in rdirs:
            for f in sorted(d.iterdir()):
                if f.suffix.lower() not in (".png", ".jpg", ".jpeg"):
                    continue
                mm2 = re.match(r"(\d{3,4})_(.+?)_(\d+)$", f.stem)
                key = (mm2.group(1), mm2.group(2)) if mm2 else (f.stem, "")
                groups.setdefault(key, f)
        for i, ((tt, name), f) in enumerate(sorted(groups.items())[:PHOTO_CAP_ROAD], 1):
            pid = f"{mmdd}-yt-{i}"
            t = f"{tt[:-2]}:{tt[-2:]}" if len(tt) >= 3 and tt.isdigit() else ""
            if save_photo(f, pid):
                photos[pid] = {"c": name, "t": t}
                road_pids.append(pid)

        # —— 沿途观测表 ——
        roadside = []
        for cells in parse_md_table(md_section(body, ["沿途观测", "沿途观测点"])):
            if len(cells) >= 4:
                roadside.append({"time": cells[0], "spot": strip_links_text(cells[1]),
                                 "alt": cells[2], "note": strip_links_text(cells[3])[:160]})

        # —— 概要 callout ——
        summary = ""
        mcall = re.search(r">\s*\[!abstract\][^\n]*\n((?:>[^\n]*\n?)+)", body)
        if mcall:
            summary = strip_links_text(re.sub(r"^>\s?", "", mcall.group(1), flags=re.M))

        keypoints = md_section(body, ["当日要点", "主要收获"])
        import datetime
        wd = datetime.date(*[int(t) for t in date.split("-")]).weekday()
        week = "星期" + "一二三四五六日"[wd]

        days.append({
            "date": date, "key": mmdd, "short": short, "week": str(fm.get("星期", week)),
            "route": str(fm.get("路线", "")), "altRange": str(fm.get("海拔区间", "")),
            "summary": summary[:400], "points": pts, "roadside": roadside,
            "roadPhotos": road_pids, "keypoints": keypoints[:2500],
            "wx": wx, "dayNoteId": dn.stem,
        })
    return days, photos, points_coord, venue_coord

# ---------------------------------------------------------------- main

print("== 1/5 地图图层 ==")
map_layers, named_lakes = build_map()
for k, v in map_layers.items():
    print(f"  {k}: {len(v)}")

print("== 2/5 地名坐标 ==")
gaz = build_gazetteer(named_lakes)
place_notes = [p.stem for p in VAULT.glob(f"{VC['placeFolder']}/*.md")]
miss = [n for n in place_notes if n not in gaz]
print("  地点笔记:", len(place_notes), "| 未定位:", miss)

print("== 3/5 每日行程 ==")
days, photos, points_coord, venue_coord = build_days(gaz)
for d in days:
    ok = sum(1 for p in d["points"] if p["coord"])
    miss_pts = [p['title'] for p in d['points'] if not p['coord']]
    print(f"  {d['date']}: 讲解点 {len(d['points'])}(有坐标 {ok}) 沿途 {len(d['roadside'])} "
          f"照片 {sum(len(p['photos']) for p in d['points'])}+{len(d['roadPhotos'])} "
          f"气象 {len(d['wx']['rows']) if d['wx'] else 0}"
          + (f" 缺坐标:{miss_pts}" if miss_pts else ""))

print("== 4/5 知识图谱 ==")
nodes = build_graph(gaz, points_coord, venue_coord, photos)
kinds = Counter(n["k"] for n in nodes)
print("  节点:", len(nodes), dict(kinds))
print("  链接:", sum(len(n["out"]) for n in nodes))

# 地点图层（用于地图「知识地点」标注）
places_layer = []
for n in nodes:
    if n["k"] == "地点" and "c" in n:
        # 不在地名表里的说明坐标是从讲解点继承来的，一律算近似
        places_layer.append({"n": n["t"], "x": n["c"][0], "y": n["c"][1], "id": n["id"],
                             "approx": gaz.get(n["t"], {}).get("approx", True)})
map_layers["places"] = places_layer


def dump(name, obj):
    p = OUT / name
    p.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  {name}: {p.stat().st_size/1024:.0f} KB")


# 清掉上一轮遗留、本轮没再生成的照片（换配置/删照片后不留垃圾）
stale = [p for p in PHOTO_DIR.glob("*.jpg") if p.stem not in photos]
for p in stale:
    p.unlink()
if stale:
    print(f"  清理过期照片 {len(stale)} 张")

print("== 5/5 输出 ==")
dump("map_data.json", {"bounds": [round(b, 5) for b in AREA_BOUNDS], "layers": map_layers})
dump("graph_data.json", {"nodes": nodes})
dump("days_data.json", days)
dump("photos_index.json", photos)
dump("site_data.json", {
    "id": CFG["id"],
    **CFG["site"],
    "qa": CFG["qa"],
    "kinds": CFG.get("kinds", {}),
    "themes": [t for t in CFG.get("mapThemes", []) if not t.get("layer") or map_layers.get(t["layer"])],
    "stats": {"nodes": len(nodes), "days": len(days),
              "points": sum(len(d["points"]) for d in days),
              "photos": len(photos)},
})
ph_kb = sum(p.stat().st_size for p in PHOTO_DIR.glob("*.jpg")) / 1024
print(f"  photos/: {len(photos)} 张，{ph_kb:.0f} KB")
print("done")
