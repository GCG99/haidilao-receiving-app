import type { Supplier } from "./types";

const make = (id: string, name: string, type: Supplier["type"]): Supplier => ({
  id,
  name,
  type
});

// 只作为飞书暂时不可用时的备用计划。
// 正常情况下网页从飞书“供应商计划”读取。
export const fallbackSuppliers: Record<number, Supplier[]> = {
  0: [
    make("fresh", "领鲜", "produce"),
    make("beifang", "北方", "northern")
  ],
  1: [
    make("fresh", "领鲜", "produce"),
    make("zhangji", "张记", "other"),
    make("cowrock", "Cowrock", "meat"),
    make("kleanking", "Kleaning KING", "other"),
    make("friendship", "Friendship", "other"),
    make("waizu", "外租", "other"),
    make("bne", "BNE", "other"),
    make("jfc", "JFC", "other"),
    make("htc", "HTC", "other"),
    make("discount", "Discount solution", "other"),
    make("funglea", "Funglea", "frozen")
  ],
  2: [
    make("fresh", "领鲜", "produce"),
    make("beifang", "北方", "northern"),
    make("cfc", "CFC", "frozen"),
    make("oldbeifang", "老北方", "frozen"),
    make("friendship", "Friendship", "other"),
    make("zongcang", "总仓", "other"),
    make("yangletuo", "养乐多", "other"),
    make("bne", "BNE", "other"),
    make("discount", "Discount solution", "other"),
    make("kleanking", "Kleaning KING", "other"),
    make("mingfa", "明发", "frozen")
  ],
  3: [
    make("fresh", "领鲜", "produce"),
    make("waizu", "外租", "other"),
    make("yangjiu", "洋酒", "other"),
    make("cowrock", "Cowrock", "meat"),
    make("zapi", "扎啤", "other"),
    make("bne", "BNE", "other"),
    make("kleanking", "Kleaning KING", "other"),
    make("zhangji", "张记", "other"),
    make("discount", "Discount solution", "other"),
    make("funglea", "Funglea", "frozen")
  ],
  4: [
    make("fresh", "领鲜", "produce"),
    make("oldbeifang", "老北方", "frozen"),
    make("zongcang", "总仓", "other"),
    make("bne", "BNE", "other"),
    make("discount", "Discount solution", "other"),
    make("kleanking", "Kleaning KING", "other")
  ],
  5: [
    make("fresh", "领鲜", "produce"),
    make("cfc", "CFC", "frozen"),
    make("cowrock", "Cowrock", "meat"),
    make("kleanking", "Kleaning KING", "other"),
    make("friendship", "Friendship", "other"),
    make("htc", "HTC", "other"),
    make("discount", "Discount solution", "other"),
    make("jfc", "JFC", "other"),
    make("unesco", "UNESCO", "other"),
    make("zhangji", "张记", "other"),
    make("bne", "BNE", "other"),
    make("waizu", "外租", "other"),
    make("chaofan", "炒饭", "frozen"),
    make("beifang", "北方", "northern")
  ],
  6: [
    make("fresh", "领鲜", "produce"),
    make("oldbeifang", "老北方", "frozen"),
    make("zongcang", "总仓", "other")
  ]
};

export const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export const weightedFreshProducts = [
  "去泥红皮土豆 Red Potato Size M",
  "红萝卜 Carrot Large",
  "青柠",
  "黄柠檬",
  "冬瓜（大）Winter Melon（big）",
  "圣女果",
  "绿猕猴桃",
  "火龙果（白心）",
  "鲜橙",
  "西瓜（无籽）Water Melon",
  "大苹果",
  "柚子",
  "黄心番薯"
];

export const typeLabels: Record<string, string> = {
  produce: "领鲜",
  frozen: "冻货",
  meat: "Cowrock",
  northern: "北方",
  other: "普通"
};
