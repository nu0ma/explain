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
  render: (text: string, ctx: RenderContext) => string;
};
