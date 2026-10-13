// Stage checkpoints for background generation jobs.
//
// A pipeline stage wrapped in runCheckpointedStage:
// - is skipped when `context.checkpoints[stage]` holds an output that passes the
//   stage's own validity check (so a resumed job never repeats finished work);
// - otherwise reports itself through `context.onStage`, runs, and hands its
//   validated output to `context.saveCheckpoint` right after it succeeds.
// Without a context (the evaluation CLI, direct service calls) the stage simply
// runs, exactly as before.

const runCheckpointedStage = async (context, stage, { run, isValid }) => {
  const checkpoints = context?.checkpoints;
  if (checkpoints && Object.hasOwn(checkpoints, stage)) {
    const saved = checkpoints[stage];
    if (isValid(saved)) {
      if (context.onStage) await context.onStage(stage, { fromCheckpoint: true });
      return saved;
    }
    console.warn('Ignoring an invalid stage checkpoint; the stage will run again.', JSON.stringify({ stage }));
  }

  if (context?.onStage) await context.onStage(stage, { fromCheckpoint: false });
  const output = await run();
  if (context?.saveCheckpoint) await context.saveCheckpoint(stage, output);
  return output;
};

module.exports = { runCheckpointedStage };
