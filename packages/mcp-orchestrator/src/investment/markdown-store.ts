import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  AssetCandidate,
  InvestmentAssetDossier,
  InvestmentIntakeRecord,
  InvestmentIntakeRequest,
} from '@agentic/shared-types';

type IntakeIndex = {
  version: 1;
  intakes: Record<string, InvestmentIntakeRecord>;
};

type AssetNoteRef = {
  intake_id: string;
  source_submission_id: string;
  created_at: string;
  title: string;
  summary: string;
  why_it_might_matter: string;
  open_questions: string[];
};

type StoredAssetEntry = {
  asset: InvestmentAssetDossier;
  note_refs: AssetNoteRef[];
};

type AssetIndex = {
  version: 1;
  assets: Record<string, StoredAssetEntry>;
};

function todayDate(now: string): string {
  return now.slice(0, 10);
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function formatFrontmatter(fields: Record<string, string | number | boolean | null | string[]>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((item) => JSON.stringify(item)).join(', ')}]`);
      continue;
    }
    if (value === null) {
      lines.push(`${key}: null`);
      continue;
    }
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function formatAssetCandidate(candidate: AssetCandidate): string {
  const key = candidate.asset_key ?? '(unresolved)';
  const ticker = candidate.ticker ? ` / ${candidate.ticker}` : '';
  return `- ${candidate.display_name} [${candidate.asset_type}] ${key}${ticker}`;
}

function formatRawInput(rawInput: string): string {
  const content = rawInput.trim() || '(empty)';
  return ['```text', content, '```'].join('\n');
}

export class InvestmentMarkdownStore {
  private readonly baseDir: string;
  private readonly intakeDir: string;
  private readonly assetDir: string;
  private readonly intakeIndexPath: string;
  private readonly assetIndexPath: string;

  constructor(dataDir: string) {
    this.baseDir = join(dataDir, 'investment-module');
    this.intakeDir = join(this.baseDir, 'intake');
    this.assetDir = join(this.baseDir, 'assets');
    this.intakeIndexPath = join(this.baseDir, 'intakes.json');
    this.assetIndexPath = join(this.baseDir, 'assets.json');
  }

  async createIntake(request: InvestmentIntakeRequest): Promise<InvestmentIntakeRecord> {
    const createdAt = new Date().toISOString();
    const intakeId = randomUUID();
    const assetType = request.asset_candidates.find((item) => item.asset_key)?.asset_type ?? 'unresolved';
    const dateDir = join(this.intakeDir, todayDate(createdAt));
    const notePath = join(dateDir, `${sanitizeFileName(intakeId)}.md`);

    const record: InvestmentIntakeRecord = {
      intake_id: intakeId,
      source_submission_id: request.source_submission_id,
      created_at: createdAt,
      asset_candidates: request.asset_candidates,
      asset_type: assetType,
      input_kind: request.input_kind,
      channel_ref: request.channel_ref ?? null,
      auto_actions: request.auto_actions,
      note_path: notePath,
      raw_input: request.raw_input,
      investment_note: request.investment_note,
    };

    await mkdir(dateDir, { recursive: true });
    await writeFile(notePath, this.renderIntakeMarkdown(record), 'utf8');

    const index = await this.readIntakeIndex();
    index.intakes[intakeId] = record;
    await this.writeIntakeIndex(index);
    return record;
  }

  async appendToAssetDossiers(record: InvestmentIntakeRecord): Promise<InvestmentAssetDossier[]> {
    const index = await this.readAssetIndex();
    const dossiers: InvestmentAssetDossier[] = [];
    const seen = new Set<string>();
    const resolvedCandidates = record.asset_candidates.filter(
      (candidate) => candidate.asset_key && !seen.has(candidate.asset_key),
    );

    for (const candidate of resolvedCandidates) {
      const assetKey = candidate.asset_key!;
      seen.add(assetKey);
      const current = index.assets[assetKey];
      const nextNoteRefs = [
        {
          intake_id: record.intake_id,
          source_submission_id: record.source_submission_id,
          created_at: record.created_at,
          title: record.investment_note.title,
          summary: record.investment_note.summary,
          why_it_might_matter: record.investment_note.why_it_might_matter,
          open_questions: record.investment_note.open_questions,
        },
        ...(current?.note_refs ?? []),
      ].slice(0, 20);

      const assetPath = join(
        this.assetDir,
        candidate.asset_type,
        `${sanitizeFileName(assetKey)}.md`,
      );
      const dossier: InvestmentAssetDossier = {
        asset_key: assetKey,
        asset_type: candidate.asset_type,
        display_name: candidate.display_name,
        note_count: nextNoteRefs.length,
        linked_submission_ids: uniqueStrings(
          nextNoteRefs.map((note) => note.source_submission_id),
        ),
        intake_ids: uniqueStrings(nextNoteRefs.map((note) => note.intake_id)),
        dossier_path: assetPath,
        updated_at: new Date().toISOString(),
      };
      index.assets[assetKey] = {
        asset: dossier,
        note_refs: nextNoteRefs,
      };

      await mkdir(join(this.assetDir, candidate.asset_type), { recursive: true });
      await writeFile(
        assetPath,
        this.renderAssetMarkdown(candidate, dossier, nextNoteRefs),
        'utf8',
      );
      dossiers.push(dossier);
    }

    await this.writeAssetIndex(index);
    return dossiers;
  }

  async getIntake(intakeId: string): Promise<{ intake: InvestmentIntakeRecord; markdown: string } | null> {
    const index = await this.readIntakeIndex();
    const intake = index.intakes[intakeId];
    if (!intake) {
      return null;
    }
    const markdown = await readFile(intake.note_path, 'utf8');
    return { intake, markdown };
  }

  async getAsset(assetKey: string): Promise<{ asset: InvestmentAssetDossier; markdown: string } | null> {
    const index = await this.readAssetIndex();
    const entry = index.assets[assetKey];
    if (!entry) {
      return null;
    }
    const markdown = await readFile(entry.asset.dossier_path, 'utf8');
    return { asset: entry.asset, markdown };
  }

  async listRecentNotesForAsset(assetKey: string, limit = 5): Promise<InvestmentIntakeRecord[]> {
    const assetIndex = await this.readAssetIndex();
    const entry = assetIndex.assets[assetKey];
    if (!entry) {
      return [];
    }
    const intakeIndex = await this.readIntakeIndex();
    return entry.note_refs
      .slice(0, limit)
      .map((note) => intakeIndex.intakes[note.intake_id])
      .filter((item): item is InvestmentIntakeRecord => Boolean(item));
  }

  private renderIntakeMarkdown(record: InvestmentIntakeRecord): string {
    const frontmatter = formatFrontmatter({
      intake_id: record.intake_id,
      source_submission_id: record.source_submission_id,
      created_at: record.created_at,
      asset_candidates: record.asset_candidates.map((item) => item.asset_key ?? item.display_name),
      asset_type: record.asset_type,
      input_kind: record.input_kind,
      channel_ref: record.channel_ref ?? null,
      auto_actions: record.auto_actions.map((item) => `${item.action}:${item.ticker}`),
    });
    const note = record.investment_note;
    return [
      frontmatter,
      '',
      `# ${note.title}`,
      '',
      '# Raw Input',
      '',
      formatRawInput(record.raw_input),
      '',
      '# Structured Summary',
      '',
      ...(note.structured_summary.length > 0 ? note.structured_summary.map((item) => `- ${item}`) : ['- (none)']),
      '',
      '# Why It Might Matter',
      '',
      note.why_it_might_matter || '(none)',
      '',
      '# Beneficiary Hints',
      '',
      ...(note.beneficiary_hints.length > 0 ? note.beneficiary_hints.map((item) => `- ${item}`) : ['- (none)']),
      '',
      '# Open Questions',
      '',
      ...(note.open_questions.length > 0 ? note.open_questions.map((item) => `- ${item}`) : ['- (none)']),
      '',
      '# References',
      '',
      ...(note.references.length > 0 ? note.references.map((item) => `- ${item}`) : ['- (none)']),
      '',
      '# Asset Candidates',
      '',
      ...(record.asset_candidates.length > 0
        ? record.asset_candidates.map(formatAssetCandidate)
        : ['- (none)']),
    ].join('\n');
  }

  private renderAssetMarkdown(
    candidate: AssetCandidate,
    dossier: InvestmentAssetDossier,
    noteRefs: AssetNoteRef[],
  ): string {
    const potentialThesis = uniqueStrings(
      noteRefs.map((item) => item.why_it_might_matter).filter(Boolean),
    );
    const openQuestions = uniqueStrings(noteRefs.flatMap((item) => item.open_questions));
    const frontmatter = formatFrontmatter({
      asset_key: dossier.asset_key,
      asset_type: dossier.asset_type,
      display_name: dossier.display_name,
      note_count: dossier.note_count,
      updated_at: dossier.updated_at,
    });
    return [
      frontmatter,
      '',
      '# Asset Summary',
      '',
      `- Name: ${candidate.display_name}`,
      `- Asset Key: ${dossier.asset_key}`,
      `- Asset Type: ${dossier.asset_type}`,
      `- Notes: ${dossier.note_count}`,
      '',
      '# Recent Notes',
      '',
      ...(noteRefs.length > 0
        ? noteRefs.map(
            (note) =>
              `- ${note.created_at.slice(0, 10)} | ${note.title} | ${note.summary} | submission=${note.source_submission_id}`,
          )
        : ['- (none)']),
      '',
      '# Potential Thesis',
      '',
      ...(potentialThesis.length > 0 ? potentialThesis.map((item) => `- ${item}`) : ['- (none)']),
      '',
      '# Risks / Open Questions',
      '',
      ...(openQuestions.length > 0 ? openQuestions.map((item) => `- ${item}`) : ['- (none)']),
      '',
      '# Linked Submissions',
      '',
      ...(dossier.linked_submission_ids.length > 0
        ? dossier.linked_submission_ids.map((item) => `- ${item}`)
        : ['- (none)']),
    ].join('\n');
  }

  private async readIntakeIndex(): Promise<IntakeIndex> {
    try {
      const content = await readFile(this.intakeIndexPath, 'utf8');
      return JSON.parse(content) as IntakeIndex;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { version: 1, intakes: {} };
      }
      throw error;
    }
  }

  private async writeIntakeIndex(index: IntakeIndex): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.intakeIndexPath, JSON.stringify(index, null, 2), 'utf8');
  }

  private async readAssetIndex(): Promise<AssetIndex> {
    try {
      const content = await readFile(this.assetIndexPath, 'utf8');
      return JSON.parse(content) as AssetIndex;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { version: 1, assets: {} };
      }
      throw error;
    }
  }

  private async writeAssetIndex(index: AssetIndex): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.assetIndexPath, JSON.stringify(index, null, 2), 'utf8');
  }
}
