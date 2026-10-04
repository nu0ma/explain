import { sheet } from './sheet.ts';
import { doc } from './doc.ts';
import type { Template } from './panel.ts';

export type { RenderedPanel, Template, TemplateInput } from './panel.ts';

// Keyed by meta.template, which parseDoc has already validated against the allowed choices.
export const TEMPLATES: Readonly<Record<string, Template>> = { sheet, doc };
