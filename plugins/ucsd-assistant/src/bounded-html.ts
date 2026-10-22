import { setImmediate } from "node:timers/promises";
import {
  defaultTreeAdapter,
  Parser,
  Tokenizer,
  type DefaultTreeAdapterTypes,
  type Token,
} from "parse5";

const CHUNK_SIZE = 8_192;
const MAX_NODES = 20_000;
const MAX_DEPTH = 256;
const MAX_WORK = 1_000_000;
const MAX_TOKENS = 40_000;
const MAX_ATTRIBUTES = 512;

export class HtmlLimitError extends Error {
  constructor() {
    super("The source exceeds the HTML complexity limit.");
    this.name = "HtmlLimitError";
  }
}

/** One budget for all HTML parsing and traversal in a single reader operation. */
export function htmlBudget(check: () => void) {
  let work = 0;
  let nodes = 0;
  let tokens = 0;
  return {
    check,
    step() {
      check();
      if (++work > MAX_WORK) throw new HtmlLimitError();
    },
    node() {
      this.step();
      if (++nodes > MAX_NODES) throw new HtmlLimitError();
    },
    token() {
      this.step();
      if (++tokens > MAX_TOKENS) throw new HtmlLimitError();
    },
  };
}

export type HtmlBudget = ReturnType<typeof htmlBudget>;

export async function parseBoundedHtml(
  source: string,
  budget: HtmlBudget,
  fragment = false,
): Promise<DefaultTreeAdapterTypes.Document | DefaultTreeAdapterTypes.DocumentFragment> {
  budget.check();
  // parse5 is pinned to 8.0.1. These protected hooks run before its linear
  // duplicate-attribute lookup, and for tokens the tree builder may ignore.
  // Keep the attribute-bomb and parser-semantic tests when updating parse5.
  class BudgetTokenizer extends Tokenizer {
    private attributeToken: Token.Token | null = null;
    private attributes = 0;

    protected override _createAttr(first: string) {
      budget.step();
      if (this.attributeToken !== this.currentToken) {
        this.attributeToken = this.currentToken;
        this.attributes = 0;
      }
      if (++this.attributes > MAX_ATTRIBUTES) throw new HtmlLimitError();
      super._createAttr(first);
    }

    protected override prepareToken(token: Token.Token) {
      budget.token();
      super.prepareToken(token);
    }

    protected override _emitCurrentCharacterToken(location: Token.Location | null) {
      budget.step();
      super._emitCurrentCharacterToken(location);
    }
  }

  class BudgetParser extends Parser<DefaultTreeAdapterTypes.DefaultTreeAdapterMap> {
    constructor(
      ...args: ConstructorParameters<typeof Parser<DefaultTreeAdapterTypes.DefaultTreeAdapterMap>>
    ) {
      super(...args);
      // Construct before getFragmentParser initializes the tokenizer context.
      this.tokenizer = new BudgetTokenizer(this.options, this);
    }
  }
  let depth = 0;
  const treeAdapter: typeof defaultTreeAdapter = {
    ...defaultTreeAdapter,
    createDocument() {
      budget.node();
      return defaultTreeAdapter.createDocument();
    },
    createDocumentFragment() {
      budget.node();
      return defaultTreeAdapter.createDocumentFragment();
    },
    createElement(...args) {
      budget.node();
      return defaultTreeAdapter.createElement(...args);
    },
    createCommentNode(data) {
      budget.node();
      return defaultTreeAdapter.createCommentNode(data);
    },
    adoptAttributes(recipient, attributes) {
      // Repeated html/body tokens can grow one element beyond the per-token cap.
      // Bound the recipient and charge existing attributes before parse5 rebuilds
      // its attribute-name Set, even when the incoming token has no attributes.
      const existing = defaultTreeAdapter.getAttrList(recipient);
      if (existing.length > MAX_ATTRIBUTES) throw new HtmlLimitError();
      const names = new Set<string>();
      for (const attribute of existing) {
        budget.step();
        names.add(attribute.name);
      }
      for (const attribute of attributes) {
        budget.step();
        names.add(attribute.name);
        if (names.size > MAX_ATTRIBUTES) throw new HtmlLimitError();
      }
      defaultTreeAdapter.adoptAttributes(recipient, attributes);
    },
    insertText(parent, text) {
      budget.step();
      const previous = parent.childNodes.at(-1);
      if (!previous || !defaultTreeAdapter.isTextNode(previous)) budget.node();
      defaultTreeAdapter.insertText(parent, text);
    },
    insertTextBefore(parent, text, reference) {
      budget.step();
      const previous = parent.childNodes[parent.childNodes.indexOf(reference) - 1];
      if (!previous || !defaultTreeAdapter.isTextNode(previous)) budget.node();
      defaultTreeAdapter.insertTextBefore(parent, text, reference);
    },
    setDocumentType(...args) {
      budget.node();
      defaultTreeAdapter.setDocumentType(...args);
    },
    onItemPush() {
      budget.step();
      // The parser stack also covers template contents and foreign elements,
      // which cannot be bounded reliably by following DOM parent pointers.
      if (++depth > MAX_DEPTH) throw new HtmlLimitError();
    },
    onItemPop() {
      budget.step();
      depth--;
    },
  };
  const options = { treeAdapter, scriptingEnabled: false };
  const parser = fragment
    ? BudgetParser.getFragmentParser(null, options)
    : new BudgetParser(options);
  for (let offset = 0; offset < source.length; offset += CHUNK_SIZE) {
    budget.step();
    parser.tokenizer.write(source.slice(offset, offset + CHUNK_SIZE), false);
    // Real event-loop yields let caller cancellation run, including when tokens
    // produce no nodes. Small writes also bound one uninterrupted tokenizer turn.
    await setImmediate();
  }
  budget.check();
  parser.tokenizer.write("", true);
  const result = fragment ? parser.getFragment() : parser.document;
  budget.check();
  return result;
}
