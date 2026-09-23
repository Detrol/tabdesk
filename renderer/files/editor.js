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
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';

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

function rgb(color) {
  const hex = /^#([\da-f]{6})$/i.exec(color || '')?.[1];
  return hex ? [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16)) : null;
}

function luminance(color) {
  return color.reduce((sum, channel, index) => {
    const value = channel / 255;
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

function readableColor(color, tokens) {
  const source = rgb(color);
  const background = rgb(tokens.surface) || rgb(tokens.bg) || rgb(FALLBACK_TOKENS.surface);
  if (!source || !background) return color;
  const backgroundLuminance = luminance(background);
  const target = backgroundLuminance < 0.18 ? 255 : 0;
  for (let step = 0; step <= 20; step++) {
    const candidate = source.map((channel) => Math.round(channel + (target - channel) * step / 20));
    const foregroundLuminance = luminance(candidate);
    const contrast = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
      / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    if (contrast >= 4.5) return step ? `rgb(${candidate.join(', ')})` : color;
  }
  return target ? '#ffffff' : '#000000';
}

function editorTheme(theme = {}) {
  const tokens = { ...FALLBACK_TOKENS, ...(theme.tokens || {}) };
  const textColor = readableColor(tokens.text, tokens);
  return EditorView.theme({
    '&': {
      height: '100%',
      color: textColor,
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
      color: textColor,
      backgroundColor: tokens.surface,
      borderColor: tokens.line,
    },
    '.cm-textfield, .cm-button': {
      color: textColor,
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
      color: textColor,
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

function editorAppearance(theme = {}) {
  const tokens = { ...FALLBACK_TOKENS, ...(theme.tokens || {}) };
  const colors = theme.terminal || {};
  const highlights = HighlightStyle.define([
    { tag: tags.comment, color: readableColor(colors.brightBlack || tokens.text, tokens), fontStyle: 'italic' },
    { tag: tags.keyword, color: readableColor(colors.magenta || tokens['accent-2'], tokens) },
    { tag: tags.string, color: readableColor(colors.green || tokens.ok || tokens.accent, tokens) },
    { tag: tags.number, color: readableColor(colors.yellow || tokens.warn || tokens['accent-2'], tokens) },
    { tag: tags.typeName, color: readableColor(colors.yellow || tokens.warn || tokens['accent-2'], tokens) },
    { tag: tags.propertyName, color: readableColor(colors.cyan || tokens['accent-2'], tokens) },
    { tag: tags.function(tags.variableName), color: readableColor(colors.blue || tokens.accent, tokens) },
  ]);
  return [editorTheme(theme), syntaxHighlighting(highlights)];
}

function clampPosition(value, length, fallback) {
  const position = Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(length, position));
}

export function createEditor({
  parent,
  onChange,
  onSave,
  theme,
  label,
  languageMatcher,
} = {}) {
  const language = new Compartment();
  const appearance = new Compartment();
  const editability = new Compartment();
  let suppressChange = false;
  let languageRequest = 0;
  let destroyed = false;
  let currentLanguage = [];
  let currentTheme = editorAppearance(theme);
  let currentReadOnly = false;
  let currentLabel = typeof label === 'string' ? label : '';

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

  function editabilityExtension() {
    return [
      EditorState.readOnly.of(currentReadOnly),
      EditorView.editable.of(!currentReadOnly),
    ];
  }

  function createState(doc, selection) {
    return EditorState.create({
      doc,
      selection,
      extensions: [
        language.of(currentLanguage),
        appearance.of(currentTheme),
        editability.of(editabilityExtension()),
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
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
          'aria-label': currentLabel,
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressChange) {
            change(update.state.doc.toString());
          }
        }),
      ],
    });
  }

  const view = new EditorView({
    parent,
    state: createState('', { anchor: 0, head: 0 }),
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
        view.setState(createState(nextContent, { anchor, head }));
      } finally {
        suppressChange = false;
      }
    },

    getDocument() {
      return view.state.doc.toString();
    },

    setReadOnly(readOnly) {
      currentReadOnly = Boolean(readOnly);
      reconfigure(editability, editabilityExtension());
    },

    async setLanguage(filename) {
      const token = ++languageRequest;
      const matchDefault = (candidate) => (
        LanguageDescription.matchFilename(languages, candidate || '')
      );
      const description = typeof languageMatcher === 'function'
        ? languageMatcher(filename || '', matchDefault)
        : LanguageDescription.matchFilename(languages, filename || '');
      if (!description) {
        if (token === languageRequest) {
          currentLanguage = [];
          reconfigure(language, currentLanguage);
        }
        return;
      }

      try {
        const support = await description.load();
        if (token === languageRequest) {
          currentLanguage = support;
          reconfigure(language, currentLanguage);
        }
      } catch {
        if (token === languageRequest) {
          currentLanguage = [];
          reconfigure(language, currentLanguage);
        }
      }
    },

    setTheme(nextTheme) {
      currentTheme = editorAppearance(nextTheme);
      reconfigure(appearance, currentTheme);
    },

    setLabel(nextLabel) {
      currentLabel = typeof nextLabel === 'string' ? nextLabel : '';
      if (!destroyed) view.contentDOM.setAttribute('aria-label', currentLabel);
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
