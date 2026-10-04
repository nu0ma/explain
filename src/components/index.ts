// Component registry: code block language name -> component.
import type { Component } from './types.ts';
import callout from './callout.ts';
import kv from './kv.ts';
import timeline from './timeline.ts';
import annot from './annot.ts';
import tree from './tree.ts';
import limits from './limits.ts';
import sequence from './sequence.ts';
import flow from './flow.ts';

export { ComponentError } from './error.ts';
export type { Component, RenderContext } from './types.ts';

const ALL: Component[] = [callout, kv, timeline, annot, tree, limits, sequence, flow];

export const COMPONENTS: Map<string, Component> = new Map(ALL.map((c) => [c.name, c]));
export const RAW_LANGS: Set<string> = new Set(['html', 'svg']);
