function isolatedTmuxEnvironment(baseEnvironment, tmuxRoot) {
  const environment = { ...baseEnvironment, TMUX_TMPDIR: tmuxRoot };
  delete environment.TMUX;
  delete environment.TMUX_PANE;
  return environment;
}

module.exports = { isolatedTmuxEnvironment };
