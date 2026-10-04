// Context passed to a component's render: the fence arguments and a generator for page-unique SVG ids.
export type RenderContext = {
  args: string;
  uid: () => string;
};

// A component renders the body of a code block whose language is its name.
export type Component = {
  name: string;
  summary: string;
  syntax: string;
  example: string;
  // When to use the component and how to use it well, printed by `explain help <name>`.
  tips: string;
  render: (text: string, ctx: RenderContext) => string;
};
