// 部品の登録表：コードブロックの言語名 → 部品。各部品は { name, summary, syntax, example, render(text, ctx) } を持つ。
import callout from './callout.ts';
import kv from './kv.ts';
import timeline from './timeline.ts';
import annot from './annot.ts';
import tree from './tree.ts';
import limits from './limits.ts';
import sequence from './sequence.ts';
import flow from './flow.ts';

export { ComponentError } from './error.ts';

const ALL = [callout, kv, timeline, annot, tree, limits, sequence, flow];

/**
 * @typedef {{ name: string, summary: string, syntax: string, example: string, render: (text: string, ctx: { args: string, uid: () => string }) => string }} Component
 * @type {Map<string, Component>}
 */
export const COMPONENTS = new Map(ALL.map((c) => [c.name, c]));
export const RAW_LANGS = new Set(['html', 'svg']);
