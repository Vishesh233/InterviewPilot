import { Badge, Card } from '@/components/ui/Primitives';
import { ProgressBar, Stat } from '@/components/ui/DataDisplay';
import { Icon } from '@/components/ui/Icon';

// Resume match is deliberately kept separate from requirement coverage:
//   coverage  = does the question bank cover the JD requirement?
//   resume    = does the resume demonstrate it?
const MATCH_TONES = { matched: 'green', partial: 'amber', missing: 'red' };
const MATCH_LABELS = { matched: 'In your resume', partial: 'Partially shown', missing: 'Not in your resume' };

function MatchGroup({ entries, title, description, icon }) {
  if (entries.length === 0) return null;
  return <Card className="overflow-hidden">
    <div className="border-b border-line px-5 py-4 sm:px-6">
      <div className="flex items-center gap-2"><Icon className="text-brand-600" name={icon} size={16} /><h2 className="font-semibold text-ink">{title}</h2><Badge tone={MATCH_TONES[entries[0].status]}>{entries.length}</Badge></div>
      <p className="mt-1 text-xs text-muted">{description}</p>
    </div>
    <ul className="divide-y divide-line">
      {entries.map((entry) => <li className="px-5 py-4 sm:px-6" key={entry.requirement}>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-ink">{entry.requirement}</p>
          <Badge tone={MATCH_TONES[entry.status]}>{MATCH_LABELS[entry.status]}</Badge>
        </div>
        {entry.evidence && <p className="mt-2 border-l-2 border-brand-200 pl-3 text-xs leading-5 text-muted">{entry.evidence}</p>}
      </li>)}
    </ul>
  </Card>;
}

export default function ResumePanel({ kit }) {
  const resume = kit?.resume || {};
  const analysis = kit?.resume_analysis || {};
  const matches = Array.isArray(analysis.matches) ? analysis.matches : [];
  if (matches.length === 0) {
    return <Card className="p-8 text-center text-sm text-muted">No resume analysis was recorded for this kit.</Card>;
  }
  const matched = matches.filter((entry) => entry.status === 'matched');
  const partial = matches.filter((entry) => entry.status === 'partial');
  const missing = matches.filter((entry) => entry.status === 'missing');
  const percentage = Math.max(0, Math.min(100, Number(analysis.matchPercent) || 0));
  const resumeQuestions = (kit?.questions || []).filter((question) => question.category === 'resume');
  const projects = Array.isArray(analysis.projects) ? analysis.projects : [];

  return <div className="space-y-5">
    <div><p className="eyebrow">Resume match</p><h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">What your resume shows for this role.</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-muted">Based only on the job requirements and your resume. Nothing is inferred beyond what the resume states.</p></div>
    <div className="grid gap-3 sm:grid-cols-3"><Stat label="Matched" value={matched.length} tone="green" /><Stat label="Partial" value={partial.length} /><Stat label="Not in resume" value={missing.length} /></div>
    <Card className="p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div><p className="eyebrow">Resume match</p><h3 className="mt-2 text-lg font-semibold text-ink">{percentage}% of requirements demonstrated</h3>{resume.fileName && <p className="mt-1 text-xs text-muted">{resume.fileName} · {resume.fileType === 'pdf' ? 'PDF' : 'text'} · {Number(resume.charCount) || 0} characters analyzed</p>}</div>
        <span className="text-2xl font-semibold text-brand-700">{percentage}%</span>
      </div>
      <ProgressBar className="mt-5" label="Resume match" value={percentage} />
      <p className="mt-3 text-xs leading-5 text-muted">This is not the question-bank coverage shown in Role &amp; coverage. A requirement can be fully covered by questions and still be missing from your resume.</p>
      {resumeQuestions.length > 0 && <p className="mt-3 text-xs leading-5 text-muted">{resumeQuestions.length} of your questions are grounded in this resume and its projects — they are marked “Resume &amp; project” in the Questions tab.</p>}
    </Card>
    {projects.length > 0 && <Card className="p-5 sm:p-6"><p className="eyebrow">Projects detected</p><div className="mt-3 flex flex-wrap gap-2">{projects.map((project) => <Badge key={project} tone="gray">{project}</Badge>)}</div><p className="mt-3 text-xs leading-5 text-muted">Project names found in the resume. Deep-dive questions only mention them because the resume does.</p></Card>}
    <MatchGroup description="The resume explicitly demonstrates these requirements." entries={matched} icon="check" title="Matched" />
    <MatchGroup description="The resume shows related but incomplete evidence." entries={partial} icon="warning" title="Partial" />
    <MatchGroup description="No resume evidence was found, so these are your honest preparation gaps." entries={missing} icon="warning" title="Missing" />
  </div>;
}