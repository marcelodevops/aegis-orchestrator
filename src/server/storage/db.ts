/**
 * Aegis Orchestrator - Transactional Storage Engine
 * 
 * Backed by SQLite (Node 22 DatabaseSync) with WAL mode, foreign keys,
 * and optimistic revision control for atomic state mutations.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '../../../data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = process.env.AEGIS_DB_PATH || path.resolve(DATA_DIR, 'aegis.db');

export class StorageEngine {
  private db: DatabaseSync;
  private static instance: StorageEngine | null = null;

  constructor(dbPath: string = DB_PATH) {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  public static getInstance(dbPath?: string): StorageEngine {
    if (!StorageEngine.instance) {
      StorageEngine.instance = new StorageEngine(dbPath);
    }
    return StorageEngine.instance;
  }

  public getRawDb(): DatabaseSync {
    return this.db;
  }

  private initSchema(): void {
    // Enable WAL mode for high concurrency and immediate write durability
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA foreign_keys = ON;');
    } catch {}

    this.db.exec(`
      -- Tasks table with revision control
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        epic_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('backlog', 'todo', 'in_progress', 'review', 'done', 'blocked', 'cancelled')),
        priority TEXT NOT NULL CHECK(priority IN ('critical', 'high', 'medium', 'low')),
        assigned_agent_id TEXT,
        estimated_hours REAL DEFAULT 0,
        spent_hours REAL DEFAULT 0,
        dependencies TEXT DEFAULT '[]', -- JSON array of task IDs
        tags TEXT DEFAULT '[]',         -- JSON array of strings
        deliverables TEXT DEFAULT '[]', -- JSON array of strings
        last_comment TEXT,
        jira_synced INTEGER DEFAULT 0,
        slack_notified INTEGER DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Structured Acceptance Criteria table
      CREATE TABLE IF NOT EXISTS acceptance_criteria (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        verification_method TEXT NOT NULL, -- e.g. 'trusted_test', 'schema_check', 'file_presence', 'human_review'
        verification_spec TEXT DEFAULT '{}', -- JSON configuration (command, path, regex, etc.)
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'passed', 'failed', 'blocked')),
        evidence_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Execution Runs table (records each worker run)
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('dispatched', 'running', 'awaiting_review', 'accepted', 'rejected', 'cancelled', 'failed')),
        base_commit TEXT,
        candidate_hash TEXT,
        workspace_path TEXT NOT NULL,
        diff TEXT,
        token_budget INTEGER DEFAULT 20000,
        tokens_used INTEGER DEFAULT 0,
        deadline_at TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      -- Immutable Acceptance Evidence table
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        criterion_id TEXT REFERENCES acceptance_criteria(id) ON DELETE SET NULL,
        base_commit TEXT,
        candidate_hash TEXT NOT NULL,
        verifier_name TEXT NOT NULL,
        command TEXT,
        exit_code INTEGER,
        stdout TEXT,
        stderr TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('passed', 'failed', 'error')),
        failure_reason TEXT,
        recorded_at TEXT NOT NULL
      );

      -- Security & Integration Settings (encrypted/hashed server-side)
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL, -- JSON object
        is_secret INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- Audit Log for all state transitions
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      -- Epics
      CREATE TABLE IF NOT EXISTS epics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        color TEXT NOT NULL,
        progress INTEGER DEFAULT 0
      );

      -- Agents
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        base_role TEXT NOT NULL,
        avatar TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        velocity INTEGER DEFAULT 0,
        skills TEXT DEFAULT '[]',
        dynamic_role_history TEXT DEFAULT '[]',
        completed_tasks_count INTEGER DEFAULT 0,
        provider_type TEXT DEFAULT 'gemini',
        model TEXT DEFAULT 'gemini-3.8-flash'
      );

      -- Inter-agent communications
      CREATE TABLE IF NOT EXISTS communications (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_role TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT NOT NULL,
        task_id TEXT
      );
    `);
  }

  // Transaction helper
  public transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  // --- Task Methods with Revision Control ---

  public getTaskById(id: string): any | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ? OR key = ?');
    const row = stmt.get(id, id) as any;
    if (!row) return null;
    return this.deserializeTask(row);
  }

  public getAllTasks(): any[] {
    const stmt = this.db.prepare('SELECT * FROM tasks ORDER BY created_at ASC');
    const rows = stmt.all() as any[];
    return rows.map((r) => this.deserializeTask(r));
  }

  public insertTask(task: any): any {
    const now = new Date().toISOString();
    const id = task.id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const version = 1;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO tasks (
        id, key, title, description, epic_id, status, priority, assigned_agent_id,
        estimated_hours, spent_hours, dependencies, tags, deliverables, last_comment,
        jira_synced, slack_notified, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      task.key,
      task.title,
      task.description || '',
      task.epicId || task.epic_id || 'epic-core',
      task.status || 'todo',
      task.priority || 'medium',
      task.assignedAgentId || task.assigned_agent_id || null,
      task.estimatedHours ?? task.estimated_hours ?? 0,
      task.spentHours ?? task.spent_hours ?? 0,
      JSON.stringify(task.dependencies || []),
      JSON.stringify(task.tags || []),
      JSON.stringify(task.deliverables || []),
      task.lastAgentComment || task.last_comment || '',
      task.jiraSynced ? 1 : 0,
      task.slackNotified ? 1 : 0,
      version,
      now,
      now
    );

    // Also insert subtasks as acceptance criteria
    if (Array.isArray(task.subtasks)) {
      for (const st of task.subtasks) {
        this.insertCriterion({
          id: st.id || `st-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          taskId: id,
          title: st.title,
          verificationMethod: st.verificationMethod || 'trusted_test',
          verificationSpec: st.verificationSpec || {},
          status: 'pending',
        });
      }
    }

    this.logAudit('task', id, 'created', 'system', { key: task.key, title: task.title });
    return this.getTaskById(id);
  }

  public updateTaskWithRevision(taskId: string, expectedVersion: number, updates: any, actor: string = 'system'): { success: boolean; task?: any; newVersion?: number; error?: string } {
    return this.transaction(() => {
      const current = this.getTaskById(taskId);
      if (!current) {
        return { success: false, error: `Task not found: ${taskId}` };
      }

      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        return {
          success: false,
          error: `Stale write conflict: task ${current.key} is at revision ${current.version}, expected ${expectedVersion}. Refresh state.`,
        };
      }

      const nextVersion = current.version + 1;
      const now = new Date().toISOString();

      const merged = {
        ...current,
        ...updates,
        version: nextVersion,
        updated_at: now,
      };

      const stmt = this.db.prepare(`
        UPDATE tasks SET
          title = ?,
          description = ?,
          epic_id = ?,
          status = ?,
          priority = ?,
          assigned_agent_id = ?,
          estimated_hours = ?,
          spent_hours = ?,
          dependencies = ?,
          tags = ?,
          deliverables = ?,
          last_comment = ?,
          jira_synced = ?,
          slack_notified = ?,
          version = ?,
          updated_at = ?
        WHERE id = ? AND version = ?
      `);

      stmt.run(
        merged.title,
        merged.description,
        merged.epicId,
        merged.status,
        merged.priority,
        merged.assignedAgentId,
        merged.estimatedHours,
        merged.spentHours,
        JSON.stringify(merged.dependencies || []),
        JSON.stringify(merged.tags || []),
        JSON.stringify(merged.deliverables || []),
        merged.lastAgentComment || '',
        merged.jiraSynced ? 1 : 0,
        merged.slackNotified ? 1 : 0,
        nextVersion,
        now,
        current.id,
        current.version
      );

      this.logAudit('task', current.id, 'updated', actor, {
        previousVersion: current.version,
        newVersion: nextVersion,
        previousStatus: current.status,
        newStatus: merged.status,
      });

      return { success: true, task: this.getTaskById(current.id), newVersion: nextVersion };
    });
  }

  private deserializeTask(row: any): any {
    const subtasks = this.getCriteriaForTask(row.id).map((c) => ({
      id: c.id,
      title: c.title,
      completed: c.status === 'passed',
      verificationMethod: c.verificationMethod,
      verificationSpec: c.verificationSpec,
      evidenceId: c.evidenceId,
    }));

    return {
      id: row.id,
      key: row.key,
      title: row.title,
      description: row.description,
      epicId: row.epic_id,
      status: row.status,
      priority: row.priority,
      assignedAgentId: row.assigned_agent_id,
      estimatedHours: row.estimated_hours,
      spentHours: row.spent_hours,
      dependencies: JSON.parse(row.dependencies || '[]'),
      tags: JSON.parse(row.tags || '[]'),
      deliverables: JSON.parse(row.deliverables || '[]'),
      lastAgentComment: row.last_comment,
      jiraSynced: Boolean(row.jira_synced),
      slackNotified: Boolean(row.slack_notified),
      version: row.version,
      subtasks,
      createdAt: row.created_at,
      lastUpdated: row.updated_at,
    };
  }

  // --- Acceptance Criteria ---

  public insertCriterion(c: any): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO acceptance_criteria (
        id, task_id, title, verification_method, verification_spec, status, evidence_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      c.id,
      c.taskId,
      c.title,
      c.verificationMethod || 'trusted_test',
      JSON.stringify(c.verificationSpec || {}),
      c.status || 'pending',
      c.evidenceId || null,
      now,
      now
    );
  }

  public getCriteriaForTask(taskId: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM acceptance_criteria WHERE task_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(taskId) as any[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      title: r.title,
      verificationMethod: r.verification_method,
      verificationSpec: JSON.parse(r.verification_spec || '{}'),
      status: r.status,
      evidenceId: r.evidence_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  public updateCriterionStatus(id: string, status: 'pending' | 'passed' | 'failed' | 'blocked', evidenceId?: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE acceptance_criteria
      SET status = ?, evidence_id = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(status, evidenceId || null, now, id);
  }

  // --- Runs & Evidence ---

  public createRun(run: any): any {
    const now = new Date().toISOString();
    const id = run.id || `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const stmt = this.db.prepare(`
      INSERT INTO runs (
        id, task_id, agent_id, status, base_commit, candidate_hash, workspace_path,
        diff, token_budget, tokens_used, deadline_at, error, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      run.taskId,
      run.agentId,
      run.status || 'dispatched',
      run.baseCommit || null,
      run.candidateHash || null,
      run.workspacePath,
      run.diff || null,
      run.tokenBudget || 20000,
      run.tokensUsed || 0,
      run.deadlineAt || null,
      run.error || null,
      now
    );
    this.logAudit('run', id, 'dispatched', run.agentId, { taskId: run.taskId });
    return this.getRunById(id);
  }

  public updateRun(id: string, updates: any): any {
    const current = this.getRunById(id);
    if (!current) return null;
    const now = new Date().toISOString();

    const merged = { ...current, ...updates };
    const stmt = this.db.prepare(`
      UPDATE runs SET
        status = ?,
        candidate_hash = ?,
        diff = ?,
        tokens_used = ?,
        error = ?,
        completed_at = ?
      WHERE id = ?
    `);
    stmt.run(
      merged.status,
      merged.candidateHash || null,
      merged.diff || null,
      merged.tokensUsed || 0,
      merged.error || null,
      merged.status !== 'running' && merged.status !== 'dispatched' ? (merged.completedAt || now) : null,
      id
    );
    return this.getRunById(id);
  }

  public getRunById(id: string): any | null {
    const stmt = this.db.prepare('SELECT * FROM runs WHERE id = ?');
    return stmt.get(id) || null;
  }

  public getRunsForTask(taskId: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC');
    return stmt.all(taskId) as any[];
  }

  public recordEvidence(e: {
    runId?: string;
    taskId: string;
    criterionId?: string;
    baseCommit?: string;
    candidateHash: string;
    verifierName: string;
    command?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    outcome: 'passed' | 'failed' | 'error';
    failureReason?: string;
  }): string {
    const id = `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO evidence (
        id, run_id, task_id, criterion_id, base_commit, candidate_hash,
        verifier_name, command, exit_code, stdout, stderr, outcome, failure_reason, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      e.runId || null,
      e.taskId,
      e.criterionId || null,
      e.baseCommit || null,
      e.candidateHash,
      e.verifierName,
      e.command || null,
      e.exitCode ?? null,
      e.stdout || '',
      e.stderr || '',
      e.outcome,
      e.failureReason || null,
      now
    );

    if (e.criterionId) {
      this.updateCriterionStatus(e.criterionId, e.outcome === 'passed' ? 'passed' : 'failed', id);
    }

    return id;
  }

  public getEvidenceForCandidate(taskId: string, candidateHash: string): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM evidence
      WHERE task_id = ? AND candidate_hash = ?
      ORDER BY recorded_at DESC
    `);
    return stmt.all(taskId, candidateHash) as any[];
  }

  public getEvidenceForTask(taskId: string): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM evidence
      WHERE task_id = ?
      ORDER BY recorded_at DESC
    `);
    return stmt.all(taskId) as any[];
  }

  // --- Audit Logging ---

  public logAudit(entityType: string, entityId: string, action: string, actor: string, payload: any = {}): void {
    const id = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    try {
      const stmt = this.db.prepare(`
        INSERT INTO audit_events (id, entity_type, entity_id, action, actor, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(id, entityType, entityId, action, actor, JSON.stringify(payload), now);
    } catch (e) {
      console.error('Audit log failure:', e);
    }
  }

  public getAuditEvents(limit = 100): any[] {
    const stmt = this.db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?');
    const rows = stmt.all(limit) as any[];
    return rows.map((r) => ({
      ...r,
      payload: JSON.parse(r.payload || '{}'),
    }));
  }

  // --- Settings & Secrets ---

  public getSetting(key: string): any | null {
    const stmt = this.db.prepare('SELECT value, is_secret FROM settings WHERE key = ?');
    const row = stmt.get(key) as any;
    if (!row) return null;
    return JSON.parse(row.value);
  }

  public setSetting(key: string, value: any, isSecret = false): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, is_secret, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(key, JSON.stringify(value), isSecret ? 1 : 0, now);
  }

  // Seed default data if database is empty
  public seedIfEmpty(defaultTasks: any[], defaultAgents: any[], defaultEpics: any[]): void {
    const countStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM tasks');
    const res = countStmt.get() as any;
    if (res.cnt === 0) {
      this.transaction(() => {
        // Epics
        for (const ep of defaultEpics) {
          const s = this.db.prepare('INSERT OR REPLACE INTO epics (id, title, color, progress) VALUES (?, ?, ?, ?)');
          s.run(ep.id, ep.title, ep.color, ep.progress || 0);
        }

        // Agents
        for (const ag of defaultAgents) {
          const s = this.db.prepare(`
            INSERT OR REPLACE INTO agents (
              id, name, role, base_role, avatar, status, velocity, skills, dynamic_role_history, completed_tasks_count, provider_type, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          s.run(
            ag.id,
            ag.name,
            ag.role,
            ag.baseRole || ag.role,
            ag.avatar,
            ag.status || 'idle',
            ag.velocity || 0,
            JSON.stringify(ag.skills || []),
            JSON.stringify(ag.dynamicRoleHistory || []),
            ag.completedTasksCount || 0,
            ag.providerType || 'gemini',
            ag.model || 'gemini-3.8-flash'
          );
        }

        // Tasks
        for (const t of defaultTasks) {
          this.insertTask(t);
        }
      });
    }
  }
}

export const storage = StorageEngine.getInstance();
