(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FileState = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const STATUSES = new Set([
    'unopened',
    'loading',
    'clean',
    'dirty',
    'conflict',
    'deleted',
    'error',
  ]);

  function initial() {
    return {
      status: 'unopened',
      request: 0,
      path: null,
      content: '',
      diskContent: '',
      revision: null,
      exists: false,
      ignored: false,
      error: null,
    };
  }

  function needsDiscard(state) {
    return state.status === 'dirty' || state.status === 'conflict';
  }

  function createRequestGate() {
    let current = 0;
    return {
      next() {
        current += 1;
        return current;
      },
      isCurrent(token) {
        return token === current;
      },
      invalidate() {
        current += 1;
      },
    };
  }

  function withStatus(state, status, fields) {
    if (!STATUSES.has(status)) return state;
    return { ...state, ...fields, status };
  }

  function reduce(state, event) {
    if (!state || !event || typeof event.type !== 'string') return state;

    switch (event.type) {
      case 'open-start':
        return withStatus(initial(), 'loading', {
          request: event.request,
          path: event.path,
        });

      case 'open-success':
        if (state.status !== 'loading' || event.request !== state.request) return state;
        return withStatus(state, 'clean', {
          path: event.path,
          content: event.content,
          diskContent: event.content,
          revision: event.revision,
          exists: true,
          ignored: Boolean(event.ignored),
          error: null,
        });

      case 'open-failure':
        if (state.status !== 'loading' || event.request !== state.request) return state;
        return withStatus(state, 'error', { error: event.error });

      case 'edit':
        if (!['clean', 'dirty', 'conflict'].includes(state.status)) return state;
        return withStatus(
          state,
          state.status === 'clean' ? 'dirty' : state.status,
          { content: event.content, error: null },
        );

      case 'save-success':
        if (state.status !== 'dirty') return state;
        return withStatus(state, 'clean', {
          diskContent: state.content,
          revision: event.revision,
          exists: true,
          error: null,
        });

      case 'write-snapshot':
        if (!['dirty', 'conflict'].includes(state.status)) return state;
        return withStatus(state, state.content === event.content ? 'clean' : 'dirty', {
          diskContent: event.content,
          revision: event.revision,
          exists: true,
          ignored: Boolean(event.ignored),
          error: null,
        });

      case 'disk-changed':
        if (state.status === 'clean' && event.exists === false) {
          return withStatus(state, 'deleted', { exists: false, error: null });
        }
        if (state.status === 'dirty' || state.status === 'conflict') {
          return withStatus(state, 'conflict', {
            exists: event.exists !== false,
            error: null,
          });
        }
        return state;

      case 'disk-snapshot': {
        const disk = {
          diskContent: event.content,
          revision: event.revision,
          exists: true,
          ignored: Boolean(event.ignored),
          error: null,
        };
        if (state.status === 'clean') {
          return withStatus(state, 'clean', { ...disk, content: event.content });
        }
        if (state.status === 'dirty' || state.status === 'conflict') {
          return withStatus(state, 'conflict', disk);
        }
        return state;
      }

      case 'reload-success':
        if (!['clean', 'dirty', 'conflict', 'deleted', 'error'].includes(state.status)) return state;
        return withStatus(state, 'clean', {
          content: event.content,
          diskContent: event.content,
          revision: event.revision,
          exists: true,
          ignored: Boolean(event.ignored),
          error: null,
        });

      case 'overwrite-success':
        if (state.status !== 'conflict' || !state.exists) return state;
        return withStatus(state, 'clean', {
          diskContent: state.content,
          revision: event.revision,
          exists: true,
          error: null,
        });

      case 'discard':
        return initial();

      default:
        return state;
    }
  }

  return { initial, reduce, needsDiscard, createRequestGate };
});
