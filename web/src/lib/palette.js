// 分类色取自已验证的参考色板（dataviz palette.md），槽位顺序即 CVD 安全机制。
// KIND_ORDER 是图例/筛选条目的展示顺序；兼容旧地理现场类型，教务站点默认显示教务类型。
export const KIND_ORDER = ['索引', '政策文件', '办事指南', '常见问题', '通知公告', '名词解释',
  '讲解点', '地点', '概念', '气象', '物种', '每日', '主线']

const KIND_LIGHT = {
  地点: '#2a78d6', 概念: '#1baf7a', 气象: '#eda100', 物种: '#008300',
  每日: '#4a3aa7', 主线: '#e34948', 索引: '#9a4b8f', 讲解点: '#eb6834',
  政策文件: '#c0392b', 办事指南: '#1f6fb2', 常见问题: '#158467',
  通知公告: '#d17a00', 名词解释: '#5b5bd6',
}
const KIND_DARK = {
  地点: '#3987e5', 概念: '#199e70', 气象: '#c98500', 物种: '#008300',
  每日: '#9085e9', 主线: '#e66767', 索引: '#b06da8', 讲解点: '#d95926',
  政策文件: '#d95d4d', 办事指南: '#3d8fd1', 常见问题: '#35a88b',
  通知公告: '#e39a35', 名词解释: '#7a7aea',
}
export function kindColor(kind, dark) {
  return (dark ? KIND_DARK : KIND_LIGHT)[kind] || (dark ? '#9a9a90' : '#7a7a72')
}

// 路线/当日 分类色：第 1 天赭橙、第 2 天青蓝……与讲解点主色呼应
const DAYS_LIGHT = ['#eb6834', '#2a78d6', '#4a3aa7', '#1baf7a', '#e87ba4', '#eda100']
const DAYS_DARK = ['#d95926', '#3987e5', '#9085e9', '#199e70', '#d55181', '#c98500']
export function dayColor(i, dark) {
  const a = dark ? DAYS_DARK : DAYS_LIGHT
  return a[i % a.length]
}

// —— 制图填色（非图表分类色）：地质年代沿用地质图配色习惯，作了降饱和处理 ——
export const ERA_COLORS = {
  第四纪: '#f0e7ac', 第三纪: '#f3d18d', 白垩纪: '#bcd996', 三叠纪: '#b7a1d3',
  二叠纪: '#e2a289', 志留纪: '#abd3c3', 奥陶纪: '#9fcfc8', 寒武纪: '#b5c793',
  震旦纪: '#b8bfde', 青白口纪: '#d7accb', 岩浆侵入体: '#e5a2ab',
  古元古代: '#cfa98e', 中元古代: '#c2a58c', 未定: '#d8d4c8',
}
export const ERA_ORDER = ['第四纪', '第三纪', '白垩纪', '三叠纪', '二叠纪', '志留纪',
  '奥陶纪', '寒武纪', '震旦纪', '青白口纪', '中元古代', '古元古代', '岩浆侵入体', '未定']

export const SOIL_COLORS = {
  红壤: '#cf7a52', 黄壤: '#dcb45e', 棕壤: '#ab7d50', 黄棕壤: '#c09a58',
  草甸土: '#86a763', 水稻土: '#74a2ab', 石灰土: '#bcb59e', 紫色土: '#a06f92',
  马肝土: '#8e7a6a', 潮土: '#c5ab88', 岩性土: '#9b968c', 其他: '#b9b4a4',
}
export const VEG_COLORS = {
  松类: '#54804d', 杉类: '#37806f', 竹类: '#93b153',
  阔叶类: '#7fae49', 灌木林树种: '#b09048', 未知: '#b9b4a4',
}

// 底图要素（按明暗主题给具体色值，Leaflet/Canvas 不吃 CSS 变量）
export function baseStyle(dark) {
  return dark ? {
    water: '#27455c', waterLine: '#3d637f', river: '#4a7896',
    roadHw: '#a8804f', roadMajor: '#98876a', roadRoad: '#8a8172', roadMinor: '#5d655e',
    boundary: '#c9a86a', ink: '#e5e8e1', inkDim: 'rgba(229,232,225,.55)',
    fault: '#e66767', fold: '#9085e9', attitude: '#c98500',
    halo: 'rgba(16,23,20,.85)',
  } : {
    water: '#b9d2e4', waterLine: '#8fb4cf', river: '#7fa9c6',
    roadHw: '#b8863f', roadMajor: '#a3906a', roadRoad: '#a39c86', roadMinor: '#b3af9f',
    boundary: '#8a6a3a', ink: '#1f2924', inkDim: 'rgba(31,41,36,.55)',
    fault: '#c23b3a', fold: '#4a3aa7', attitude: '#a87200',
    halo: 'rgba(245,246,242,.88)',
  }
}
