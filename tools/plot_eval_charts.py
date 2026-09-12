"""将 GeoRAG 消融评测结果绘制为适合 PPT 使用的柱状图。"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


# SVG 中保留可编辑文本，并优先使用支持中文的本机字体。
plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["font.sans-serif"] = [
    "Microsoft YaHei",
    "STZhongsong",
    "STXingkai",
    "KaiTi",
    "Source Han Sans CN",
    "DengXian",
    "Arial",
    "DejaVu Sans",
]
plt.rcParams["svg.fonttype"] = "none"
plt.rcParams["pdf.fonttype"] = 42
plt.rcParams["axes.unicode_minus"] = False
plt.rcParams["axes.spines.right"] = False
plt.rcParams["axes.spines.top"] = False
plt.rcParams["legend.frameon"] = False


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "评测" / "eval_results.json"
OUT_DIR = ROOT / "评测" / "图表"

METHOD_KEYS = ["A 纯词法", "B +图谱", "C +邻接增强"]
METHOD_LABELS = ["仅关键词检索", "加入知识图谱", "加入邻接增强"]
METHOD_COLORS = ["#B5BDAE", "#76A55F", "#056030"]
METHOD_HATCHES = ["///", "\\\\", ""]

FAMILIES = ["概念定义", "讲解中心", "空间", "总计"]
FAMILY_LABELS = ["概念问答", "讲解内容", "附近查询", "全部题目"]
METRIC_KEYS = ["h1", "h3", "h5", "mrr"]
METRIC_LABELS = ["首条命中率", "前三条命中率", "前五条命中率", "平均排序得分"]

INK = "#183025"
MUTED = "#687568"
GRID = "#D7E0D4"
POSITIVE = "#2E7D42"
NEGATIVE = "#B25B49"
SPACE_BAND = "#F5E8D9"
DARK_GREEN = "#056030"
MID_GREEN = "#4A873C"
LIGHT_GREEN = "#8EAF79"
PALE_GREEN = "#DCE8D7"
CREAM = "#F7E8DA"
GOLD = "#F0D452"
WARM_WHITE = "#FAF9F4"
TITLE_FONT = "STZhongsong"
NAV_FONT = "STXingkai"
BODY_FONT = "Microsoft YaHei"
FIGSIZE_16_9 = (40 / 3, 7.5)


def load_results() -> tuple[dict, dict]:
    with SOURCE.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload, payload["results"]


def score(results: dict, method: str, family: str, metric: str) -> float:
    row = results[method][family]
    numerator = row["rr"] if metric == "mrr" else row[metric]
    return 100.0 * numerator / row["n"]


def write_source_csv(payload: dict, results: dict) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    output = OUT_DIR / "georag_eval_chart_data.csv"
    with output.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["配置", "题型", "题数", "指标", "数值"])
        for method in METHOD_KEYS:
            for family in FAMILIES:
                for metric, label in zip(METRIC_KEYS, METRIC_LABELS):
                    writer.writerow(
                        [method, family, payload["counts"][family], label, f"{score(results, method, family, metric):.6f}"]
                    )
    return output


def add_slide_frame(fig: plt.Figure) -> None:
    fig.patch.set_facecolor("none")
    fig.patch.set_alpha(0)


def add_axis_card(fig: plt.Figure, ax: plt.Axes, pad_x: float = 0.010, pad_y: float = 0.018) -> None:
    ax.set_facecolor("none")


def style_legend(legend: plt.Legend) -> None:
    frame = legend.get_frame()
    frame.set_visible(False)
    for text_item in legend.get_texts():
        text_item.set_color(DARK_GREEN)
        text_item.set_fontfamily(BODY_FONT)


def style_axis(ax: plt.Axes, ylabel: str = "百分制得分", ylim: tuple[float, float] = (0, 105)) -> None:
    ax.set_ylim(*ylim)
    ax.set_ylabel(ylabel, fontsize=14, color=INK, labelpad=10, fontfamily=BODY_FONT)
    ax.set_yticks(np.arange(0, 101, 20))
    ax.tick_params(axis="both", labelsize=12, colors=INK, length=0)
    ax.spines["left"].set_color(LIGHT_GREEN)
    ax.spines["bottom"].set_color(LIGHT_GREEN)
    ax.spines["left"].set_linewidth(1.0)
    ax.spines["bottom"].set_linewidth(1.0)
    ax.yaxis.grid(True, color=GRID, linewidth=0.8, alpha=0.75)
    ax.set_axisbelow(True)
    for label in [*ax.get_xticklabels(), *ax.get_yticklabels()]:
        label.set_fontfamily(BODY_FONT)


def annotate_bars(ax: plt.Axes, containers: list, fontsize: int = 11) -> None:
    for container in containers:
        for bar in container:
            value = bar.get_height()
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                value + 1.3,
                f"{value:.1f}",
                ha="center",
                va="bottom",
                fontsize=fontsize,
                color=INK,
                fontweight="semibold",
            )


def grouped_bars(
    ax: plt.Axes,
    categories: list[str],
    series: list[list[float]],
    annotate: bool = True,
) -> list:
    x = np.arange(len(categories))
    width = 0.23
    containers = []
    for index, (values, label, color, hatch) in enumerate(
        zip(series, METHOD_LABELS, METHOD_COLORS, METHOD_HATCHES)
    ):
        offset = (index - 1) * width
        bars = ax.bar(
            x + offset,
            values,
            width=width,
            color=color,
            edgecolor="white",
            linewidth=0.9,
            hatch=hatch,
            label=label,
            zorder=3,
        )
        containers.append(bars)
    ax.set_xticks(x)
    ax.set_xticklabels(categories, fontsize=13, color=INK)
    style_axis(ax)
    if annotate:
        annotate_bars(ax, containers)
    return containers


def add_title(fig: plt.Figure, title: str, subtitle: str) -> None:
    return None


def add_footer(fig: plt.Figure, text: str) -> None:
    return None


def save_figure(fig: plt.Figure, stem: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT_DIR / f"{stem}.svg", facecolor="none", transparent=True)
    fig.savefig(OUT_DIR / f"{stem}.png", dpi=300, facecolor="none", transparent=True)
    plt.close(fig)


def figure_overall(results: dict) -> None:
    series = [
        [score(results, method, "总计", metric) for metric in METRIC_KEYS]
        for method in METHOD_KEYS
    ]
    fig, ax = plt.subplots(figsize=FIGSIZE_16_9)
    add_slide_frame(fig)
    fig.subplots_adjust(left=0.09, right=0.98, bottom=0.14, top=0.86)
    add_axis_card(fig, ax)
    grouped_bars(ax, METRIC_LABELS, series)
    ax.set_ylim(84, 99)
    ax.set_yticks([84, 87, 90, 93, 96, 99])
    legend = ax.legend(loc="upper center", bbox_to_anchor=(0.5, 1.12), ncol=3, fontsize=12.2, handlelength=1.8)
    style_legend(legend)
    add_title(fig, "GeoRAG 整体检索性能", "152 道自动构建测试题；完整配置在四项指标上均为最高")
    add_footer(fig, "MRR 按百分制显示；本评测为单次确定性测试，因此不绘制误差线。")
    save_figure(fig, "01_整体检索性能")


def figure_spatial(results: dict) -> None:
    series = [
        [score(results, method, "空间", metric) for metric in METRIC_KEYS]
        for method in METHOD_KEYS
    ]
    fig, ax = plt.subplots(figsize=FIGSIZE_16_9)
    add_slide_frame(fig)
    fig.subplots_adjust(left=0.09, right=0.98, bottom=0.14, top=0.86)
    add_axis_card(fig, ax)
    grouped_bars(ax, METRIC_LABELS, series)
    ax.set_ylim(55, 87)
    ax.set_yticks([55, 60, 65, 70, 75, 80, 85])
    legend = ax.legend(loc="upper center", bbox_to_anchor=(0.5, 1.12), ncol=3, fontsize=12.2, handlelength=1.8)
    style_legend(legend)
    add_title(fig, "空间题上的检索增益", "37 道“某地附近讲了什么”测试题；空间通道明显改善首位命中")
    add_footer(fig, "空间题金标准为地名周边 400 m 内的讲解点；MRR 按百分制显示。")
    save_figure(fig, "02_空间题检索增益")


def figure_hit1_by_family(payload: dict, results: dict) -> None:
    categories = FAMILY_LABELS
    series = [
        [score(results, method, family, "h1") for family in FAMILIES]
        for method in METHOD_KEYS
    ]
    fig, ax = plt.subplots(figsize=FIGSIZE_16_9)
    add_slide_frame(fig)
    fig.subplots_adjust(left=0.09, right=0.98, bottom=0.14, top=0.86)
    add_axis_card(fig, ax)
    grouped_bars(ax, categories, series)
    ax.set_ylim(55, 103)
    ax.set_yticks([55, 60, 70, 80, 90, 100])
    legend = ax.legend(loc="upper center", bbox_to_anchor=(0.5, 1.12), ncol=3, fontsize=12.2, handlelength=1.8)
    style_legend(legend)
    add_title(fig, "不同题型的 Hit@1 对比", "空间通道的主要收益集中在空间题，对讲解中心题存在一次首位排序退化")
    add_footer(fig, "柱顶为 Hit@1 百分比；浅色背景标出空间题。")
    save_figure(fig, "03_不同题型_Hit1")


def figure_incremental(results: dict) -> None:
    graph_delta = np.array(
        [score(results, METHOD_KEYS[1], family, "h1") - score(results, METHOD_KEYS[0], family, "h1") for family in FAMILIES]
    )
    spatial_delta = np.array(
        [score(results, METHOD_KEYS[2], family, "h1") - score(results, METHOD_KEYS[1], family, "h1") for family in FAMILIES]
    )
    y = np.arange(len(FAMILIES))
    height = 0.31
    fig, ax = plt.subplots(figsize=FIGSIZE_16_9)
    add_slide_frame(fig)
    fig.subplots_adjust(left=0.13, right=0.97, bottom=0.15, top=0.86)
    add_axis_card(fig, ax)
    bars_graph = ax.barh(y + height / 2, graph_delta, height=height, color=METHOD_COLORS[1], label="加入知识图谱")
    bars_space = ax.barh(y - height / 2, spatial_delta, height=height, color=METHOD_COLORS[2], label="再加入空间检索")
    ax.axvline(0, color=INK, linewidth=1.1)
    ax.set_yticks(y)
    ax.set_yticklabels(FAMILY_LABELS, fontsize=12.5)
    ax.invert_yaxis()
    ax.set_xlim(-7.5, 13.0)
    ax.set_xticks(np.arange(-5, 13, 5))
    ax.set_xlabel("首条命中率变化（百分点）", fontsize=14, color=INK, labelpad=10)
    ax.tick_params(axis="both", labelsize=12, colors=INK, length=0)
    ax.xaxis.grid(True, color=GRID, linewidth=0.8, alpha=0.75)
    ax.set_axisbelow(True)
    ax.spines["left"].set_color(LIGHT_GREEN)
    ax.spines["bottom"].set_color(LIGHT_GREEN)
    for container in [bars_graph, bars_space]:
        for bar in container:
            value = bar.get_width()
            ax.text(
                value + (0.35 if value >= 0 else -0.35),
                bar.get_y() + bar.get_height() / 2,
                f"{value:+.1f}",
                ha="left" if value >= 0 else "right",
                va="center",
                fontsize=11.5,
                color=POSITIVE if value > 0 else NEGATIVE if value < 0 else MUTED,
                fontweight="bold",
            )
    legend = ax.legend(loc="upper center", bbox_to_anchor=(0.5, 1.12), ncol=2, fontsize=12.2)
    style_legend(legend)
    add_title(fig, "检索组件的增量贡献", "图谱改善概念定义题；空间通道抵消了图谱在空间题上的首位排序下降")
    add_footer(fig, "正值表示 Hit@1 提升，负值表示下降；差值由未四舍五入的原始计数计算。")
    save_figure(fig, "04_组件增量贡献")


def figure_overview(payload: dict, results: dict) -> None:
    fig, axes = plt.subplots(2, 2, figsize=FIGSIZE_16_9)
    add_slide_frame(fig)
    fig.subplots_adjust(left=0.075, right=0.97, bottom=0.09, top=0.84, hspace=0.30, wspace=0.24)
    for axis in axes.flat:
        add_axis_card(fig, axis, pad_x=0.008, pad_y=0.012)

    overall = [[score(results, method, "总计", metric) for metric in METRIC_KEYS] for method in METHOD_KEYS]
    spatial = [[score(results, method, "空间", metric) for metric in METRIC_KEYS] for method in METHOD_KEYS]
    hit1 = [[score(results, method, family, "h1") for family in FAMILIES] for method in METHOD_KEYS]

    for ax, data, categories, ylim, yticks in [
        (axes[0, 0], overall, METRIC_LABELS, (84, 99), [84, 87, 90, 93, 96, 99]),
        (axes[0, 1], spatial, METRIC_LABELS, (55, 87), [55, 60, 65, 70, 75, 80, 85]),
        (axes[1, 0], hit1, FAMILY_LABELS, (55, 103), [55, 60, 70, 80, 90, 100]),
    ]:
        grouped_bars(ax, categories, data, annotate=False)
        ax.set_ylim(*ylim)
        ax.set_yticks(yticks)
        ax.set_ylabel("百分制得分", fontsize=11.5)
        ax.tick_params(axis="x", labelsize=10.5)
        ax.tick_params(axis="y", labelsize=10)

    graph_delta = np.array(
        [score(results, METHOD_KEYS[1], family, "h1") - score(results, METHOD_KEYS[0], family, "h1") for family in FAMILIES]
    )
    spatial_delta = np.array(
        [score(results, METHOD_KEYS[2], family, "h1") - score(results, METHOD_KEYS[1], family, "h1") for family in FAMILIES]
    )
    ax = axes[1, 1]
    y = np.arange(len(FAMILIES))
    height = 0.30
    ax.barh(y + height / 2, graph_delta, height=height, color=METHOD_COLORS[1])
    ax.barh(y - height / 2, spatial_delta, height=height, color=METHOD_COLORS[2])
    ax.axvline(0, color=INK, linewidth=0.9)
    ax.set_yticks(y)
    ax.set_yticklabels(FAMILY_LABELS, fontsize=10.5)
    ax.invert_yaxis()
    ax.set_xlim(-7.5, 13)
    ax.set_xlabel("首条命中率变化（百分点）", fontsize=11.5)
    ax.tick_params(axis="both", labelsize=10, length=0, colors=INK)
    ax.xaxis.grid(True, color=GRID, linewidth=0.7, alpha=0.75)
    ax.set_axisbelow(True)

    handles, labels = axes[0, 0].get_legend_handles_labels()
    for axis in axes.flat:
        legend = axis.get_legend()
        if legend is not None:
            legend.remove()
    legend = fig.legend(handles, labels, loc="upper center", bbox_to_anchor=(0.5, 0.975), ncol=3, fontsize=11.3)
    style_legend(legend)
    add_title(fig, "GeoRAG 检索评测总览", "完整配置的优势集中在空间题，同时保留概念检索收益")
    add_footer(fig, f"测试集共 {payload['testsetSize']} 题；MRR 按百分制显示；单次确定性测试，无误差线。")
    save_figure(fig, "00_GeoRAG评测总览")


def main() -> None:
    payload, results = load_results()
    write_source_csv(payload, results)
    figure_overall(results)
    figure_spatial(results)
    figure_hit1_by_family(payload, results)
    figure_incremental(results)
    figure_overview(payload, results)
    print(f"已输出到：{OUT_DIR}")


if __name__ == "__main__":
    main()
