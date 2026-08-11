import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import {
  LanguageDescription,
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';

const FALLBACK_TOKENS = {
  surface: '#ffffff',
  text: '#202124',
  faint: '#70757a',
  line: '#dadce0',
  accent: '#1a73e8',
  'accent-2': '#7b1fa2',
  tint: 'rgba(26, 115, 232, 0.12)',
  danger: '#c5221f',
};

function editorTheme(theme = {}) {
  const tokens = { ...FALLBACK_TOKENS, ...(theme.tokens || {}) };
  return EditorView.theme({
    '&': {
      height: '100%',
      color: tokens.text,
      backgroundColor: tokens.surface,
    },
    '&.cm-focused': { outline: `1px solid ${tokens.accent}` },
    '.cm-scroller': { overflow: 'auto' },
    '.cm-content': { caretColor: tokens['accent-2'] },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: tokens['accent-2'] },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: tokens.tint,
    },
    '.cm-gutters': {
      color: tokens.faint,
      backgroundColor: tokens.surface,
      borderRightColor: tokens.line,
    },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: tokens.tint },
    '.cm-panels': {
      color: tokens.text,
      backgroundColor: tokens.surface,
      borderColor: tokens.line,
    },
    '.cm-textfield, .cm-button': {
      color: tokens.text,
      backgroundColor: tokens.surface,
      borderColor: tokens.line,
    },
    '.cm-searchMatch': {
      backgroundColor: tokens.tint,
      outline: `1px solid ${tokens.accent}`,
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: tokens.tint,
      outlineColor: tokens['accent-2'],
    },
    '.cm-tooltip': {
      color: tokens.text,
      backgroundColor: tokens.surface,
      borderColor: tokens.line,
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      color: tokens.text,
      backgroundColor: tokens.tint,
    },
    '.cm-diagnostic-error': { borderLeftColor: tokens.danger },
  }, { dark: Boolean(theme.dark) });
}

function clampPosition(value, length, fallback) {
  const position = Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(length, position));
}

export function createEditor({ parent, onChange, onSave, theme, label } = {}) {
  const language = new Compartment();
  const appearance = new Compartment();
  const editability = new Compartment();
  let suppressChange = false;
  let languageRequest = 0;
  let destroyed = false;

  const change = typeof onChange === 'function' ? onChange : () => {};
  const save = typeof onSave === 'function' ? onSave : () => {};
  const saveBinding = {
    key: 'Mod-s',
    preventDefault: true,
    run() {
      save();
      return true;
    },
  };

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        language.of([]),
        appearance.of(editorTheme(theme)),
        editability.of([
          EditorState.readOnly.of(false),
          EditorView.editable.of(true),
        ]),
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        highlightActiveLine(),
        search(),
        keymap.of([
          saveBinding,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.contentAttributes.of({
          'aria-label': typeof label === 'string' ? label : '',
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressChange) {
            change(update.state.doc.toString());
          }
        }),
      ],
    }),
  });

  function reconfigure(compartment, extension) {
    if (!destroyed) view.dispatch({ effects: compartment.reconfigure(extension) });
  }

  return {
    setDocument(content, selection) {
      if (destroyed) return;
      const nextContent = typeof content === 'string' ? content : '';
      const current = view.state.selection.main;
      const requested = selection || current;
      const anchor = clampPosition(requested.anchor, nextContent.length, 0);
      const head = clampPosition(requested.head, nextContent.length, anchor);

      suppressChange = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: nextContent },
          selection: { anchor, head },
        });
      } finally {
        suppressChange = false;
      }
    },

    getDocument() {
      return view.state.doc.toString();
    },

    setReadOnly(readOnly) {
      const locked = Boolean(readOnly);
      reconfigure(editability, [
        EditorState.readOnly.of(locked),
        EditorView.editable.of(!locked),
      ]);
    },

    async setLanguage(filename) {
      const token = ++languageRequest;
      const description = LanguageDescription.matchFilename(languages, filename || '');
      if (!description) {
        if (token === languageRequest) reconfigure(language, []);
        return;
      }

      try {
        const support = await description.load();
        if (token === languageRequest) reconfigure(language, support);
      } catch {
        if (token === languageRequest) reconfigure(language, []);
      }
    },

    setTheme(nextTheme) {
      reconfigure(appearance, editorTheme(nextTheme));
    },

    getSelection() {
      const { anchor, head } = view.state.selection.main;
      return { anchor, head };
    },

    focus() {
      if (!destroyed) view.focus();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      languageRequest += 1;
      view.destroy();
    },
  };
}
