/** MIT upstream Paperclip validator fixture. Entry: packages/shared/src/validators/plugin.ts @ e2cfdc7e0c7a97349846150be4036b033087fe92. Bundled without semantic changes; zod is external. See LICENSE in this directory. */

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/plugin.ts
import { z as z9 } from "zod";

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/constants.ts
var ISSUE_SUMMARIES_MAX_IDS = 5;
var ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled"
];
var INBOX_MINE_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done"
];
var INBOX_MINE_ISSUE_STATUS_FILTER = INBOX_MINE_ISSUE_STATUSES.join(",");
var ISSUE_PRIORITIES = ["critical", "high", "medium", "low"];
var ISSUE_REVIEW_POLICIES = ["anyone", "not_creator", "human_only"];
var ISSUE_WORK_MODES = ["standard", "ask", "planning", "skill_test"];
var ISSUE_HARNESS_KINDS = ["skill_test"];
var MAX_ISSUE_REQUEST_DEPTH = 1024;
var ISSUE_COMMENT_AUTHOR_TYPES = ["user", "agent", "system"];
var ISSUE_COMMENT_PRESENTATION_KINDS = ["message", "system_notice"];
var ISSUE_COMMENT_PRESENTATION_TONES = ["neutral", "info", "success", "warning", "danger"];
var ISSUE_COMMENT_PRESENTATION_DENSITIES = ["compact"];
var ISSUE_COMMENT_METADATA_ROW_TYPES = [
  "text",
  "code",
  "key_value",
  "issue_link",
  "agent_link",
  "run_link"
];
function clampIssueRequestDepth(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_ISSUE_REQUEST_DEPTH, Math.max(0, Math.floor(value)));
}
var ISSUE_THREAD_INTERACTION_KINDS = [
  "suggest_tasks",
  "ask_user_questions",
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
  "connection_intent"
];
var ISSUE_THREAD_INTERACTION_CANONICAL_RESOLVER_POLICIES = [
  "anyone",
  "not_creator",
  "human_only"
];
var ISSUE_THREAD_INTERACTION_LEGACY_RESOLVER_POLICY_ALIASES = [
  "board_or_agents",
  "board_only"
];
var ISSUE_THREAD_INTERACTION_RESOLVER_POLICIES = [
  ...ISSUE_THREAD_INTERACTION_CANONICAL_RESOLVER_POLICIES,
  ...ISSUE_THREAD_INTERACTION_LEGACY_RESOLVER_POLICY_ALIASES
];
var ISSUE_THREAD_INTERACTION_RESOLVER_POLICY_PROVENANCES = [
  "explicit",
  "inherited",
  "legacy_inherited_restriction"
];
var ISSUE_THREAD_INTERACTION_EFFECTIVE_RESOLVER_POLICY_SOURCES = [
  "requested",
  "company_cap",
  "governed_action"
];
var REQUEST_CHECKBOX_CONFIRMATION_OPTION_LIMIT = 200;
var REQUEST_ITEM_VERDICTS_ITEM_LIMIT = REQUEST_CHECKBOX_CONFIRMATION_OPTION_LIMIT;
var ISSUE_THREAD_INTERACTION_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "answered",
  "cancelled",
  "expired",
  "failed"
];
var ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES = [
  "none",
  "wake_assignee",
  "wake_assignee_on_accept"
];
var ISSUE_WATCHDOG_DISCOVERY_KINDS = ["product_bug", "platform_bug"];
var ISSUE_SURFACE_VISIBILITIES = ["default", "plugin_operation"];
var ISSUE_RECOVERY_ACTION_KINDS = [
  "missing_disposition",
  "deliberate_wait_without_target",
  "stranded_assigned_issue",
  "workspace_validation",
  "configuration_validation",
  "active_run_watchdog",
  "issue_graph_liveness"
];
var ISSUE_RECOVERY_ACTION_STATUSES = [
  "active",
  "escalated",
  "resolved",
  "cancelled"
];
var ISSUE_RECOVERY_ACTION_OWNER_TYPES = [
  "agent",
  "user",
  "board",
  "system"
];
var ISSUE_RECOVERY_ACTION_OUTCOMES = [
  "restored",
  "handed_back",
  "owner_completed",
  "delegated",
  "false_positive",
  "blocked",
  "escalated",
  "cancelled"
];
var ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY = "continuation-summary";
var SYSTEM_ISSUE_DOCUMENT_KEYS = [
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  "pipeline-case-body"
];
var SYSTEM_ISSUE_DOCUMENT_KEY_SET = new Set(SYSTEM_ISSUE_DOCUMENT_KEYS);
var EXTERNAL_OBJECT_STATUS_CATEGORIES = [
  "unknown",
  "open",
  "waiting",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "closed",
  "archived",
  "auth_required",
  "unreachable"
];
var EXTERNAL_OBJECT_STATUS_TONES = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
  "muted"
];
var EXTERNAL_OBJECT_LIVENESS_STATES = [
  "unknown",
  "fresh",
  "stale",
  "auth_required",
  "rate_limited",
  "unreachable"
];
var EXTERNAL_OBJECT_MENTION_SOURCE_KINDS = [
  "title",
  "description",
  "comment",
  "document",
  "property",
  "plugin"
];
var EXTERNAL_OBJECT_MENTION_CONFIDENCES = ["exact", "likely", "possible"];
var ISSUE_EXECUTION_POLICY_MODES = ["normal", "auto"];
var ISSUE_EXECUTION_STAGE_TYPES = ["review", "approval"];
var ISSUE_MONITOR_SCHEDULED_BY = ["assignee", "board"];
var ISSUE_EXECUTION_MONITOR_KINDS = ["external_service"];
var ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES = [
  "wake_owner",
  "create_recovery_issue",
  "escalate_to_board"
];
var ISSUE_EXECUTION_STATE_STATUSES = ["idle", "pending", "changes_requested", "completed"];
var ISSUE_EXECUTION_MONITOR_STATE_STATUSES = ["scheduled", "triggered", "cleared"];
var ISSUE_EXECUTION_MONITOR_CLEAR_REASONS = [
  "manual",
  "triggered",
  "done",
  "cancelled",
  "invalid_status",
  "invalid_assignee",
  "dispatch_skipped",
  "timeout_exceeded",
  "max_attempts_exhausted"
];
var ISSUE_EXECUTION_DECISION_OUTCOMES = ["approved", "changes_requested"];
var ROUTINE_STATUSES = ["active", "paused", "archived"];
var ROUTINE_CONCURRENCY_POLICIES = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
var ROUTINE_CATCH_UP_POLICIES = ["skip_missed", "enqueue_missed_with_cap"];
var ROUTINE_ACTIVITY_GATE_POLICIES = ["always", "require_external_activity"];
var ROUTINE_ACTIVITY_GATE_SCOPES = ["company", "project"];
var ROUTINE_TRIGGER_KINDS = ["schedule", "webhook", "api"];
var ROUTINE_TRIGGER_SIGNING_MODES = ["bearer", "app_webhook", "hmac_sha256", "github_hmac", "fireflies_hmac", "none"];
var ROUTINE_VARIABLE_TYPES = ["text", "textarea", "number", "boolean", "select", "date"];
var SECRET_PROVIDERS = [
  "local_encrypted",
  "aws_secrets_manager",
  "gcp_secret_manager",
  "vault"
];
var SECRET_PROVIDER_CONFIG_STATUSES = [
  "ready",
  "warning",
  "coming_soon",
  "disabled"
];
var SECRET_STATUSES = ["active", "disabled", "archived", "deleted"];
var SECRET_MANAGED_MODES = ["paperclip_managed", "external_reference"];
var SECRET_BINDING_TARGET_TYPES = [
  "agent",
  "project",
  "environment",
  "routine",
  "plugin",
  "issue",
  "run",
  "tool_connection",
  "system"
];
var SECRET_PROJECTION_CLASSES = ["unclassified", "class_3_static_lease"];
var PLUGIN_STATUSES = [
  "installed",
  "ready",
  "disabled",
  "error",
  "upgrade_pending",
  "uninstalled"
];
var PLUGIN_CATEGORIES = [
  "connector",
  "workspace",
  "automation",
  "ui"
];
var PLUGIN_CAPABILITIES = [
  "ai.connections.route",
  // Data Read
  "companies.read",
  "projects.read",
  "projects.instance-secrets",
  "projects.git-credentials",
  "project.workspaces.read",
  "execution.workspaces.read",
  "workspaces.manage",
  "issues.read",
  "issue.relations.read",
  "issue.subtree.read",
  "issue.comments.read",
  // Read pending issue-thread interactions (decision cards) on an issue.
  "issue.interactions.read",
  // Read issue attachment metadata and, via the capability-scoped host
  // bridge, attachment content bytes (bytes-only, company-scoped, audit-logged).
  "issue.attachments.read",
  // Read company approvals (list + get). The host redacts approval payloads to
  // match the web app's own approval read surface.
  "approvals.read",
  "issue.documents.read",
  "agents.read",
  "agents.lifecycle.manage",
  "goals.read",
  "goals.create",
  "goals.update",
  "activity.read",
  "costs.read",
  "issues.orchestration.read",
  "access.members.read",
  "access.invites.read",
  "authorization.grants.read",
  "authorization.policies.read",
  "authorization.audit.read",
  "database.namespace.read",
  // Data Write
  "issues.create",
  "issues.update",
  "issue.relations.write",
  "issues.checkout",
  "issues.wakeup",
  "issue.comments.create",
  "issue.comments.create_human_attributed",
  "issue.interactions.create",
  // Respond to (accept/reject) an issue-thread interaction on behalf of a
  // paired board user. Impersonation surface: the host independently
  // re-verifies the actor is an active human member of the company at apply
  // time (never trusts plugin-supplied identity), matching the web app's
  // board-only interaction resolve route.
  "issue.interactions.respond",
  // Decide (approve/reject) a company approval on behalf of a paired board
  // user. Same apply-time active-human-member re-verification as above; the
  // web app's approval decision routes are board-only.
  "approvals.respond",
  "issue.documents.write",
  "projects.managed",
  "routines.managed",
  "skills.managed",
  "agents.pause",
  "agents.resume",
  "agents.invoke",
  "agents.managed",
  "access.members.write",
  "access.invites.write",
  "authorization.grants.write",
  "authorization.policies.write",
  "agent.sessions.create",
  "agent.sessions.list",
  "agent.sessions.send",
  "agent.sessions.close",
  "activity.log.write",
  "metrics.write",
  "telemetry.track",
  "database.namespace.migrate",
  "database.namespace.write",
  "external.objects.detect",
  "external.objects.read",
  "external.objects.write",
  "external.objects.refresh",
  // Plugin State
  "plugin.state.read",
  "plugin.state.write",
  // Runtime / Integration
  "events.subscribe",
  "events.emit",
  "jobs.schedule",
  "webhooks.receive",
  "api.routes.register",
  "http.outbound",
  "secrets.read-ref",
  "environment.drivers.register",
  "local.folders",
  // Agent Tools
  "agent.tools.register",
  // UI
  "instance.settings.register",
  "ui.sidebar.register",
  "ui.page.register",
  "ui.detailTab.register",
  "ui.dashboardWidget.register",
  "ui.commentAnnotation.register",
  "ui.action.register"
];
var PLUGIN_DATABASE_CORE_READ_TABLES = [
  "companies",
  "projects",
  "goals",
  "agents",
  "issues",
  "issue_documents",
  "issue_relations",
  "issue_comments",
  "heartbeat_runs",
  "cost_events",
  "approvals",
  "issue_approvals",
  "budget_incidents"
];
var PLUGIN_API_ROUTE_METHODS = ["GET", "POST", "PATCH", "DELETE"];
var PLUGIN_API_ROUTE_AUTH_MODES = ["board", "agent", "board-or-agent", "webhook"];
var PLUGIN_API_ROUTE_CHECKOUT_POLICIES = [
  "none",
  "required-for-agent-in-progress",
  "always-for-agent"
];
var PLUGIN_UI_SLOT_TYPES = [
  "page",
  "detailTab",
  "taskDetailView",
  "dashboardWidget",
  "sidebar",
  "routeSidebar",
  "sidebarPanel",
  "projectSidebarItem",
  "globalToolbarButton",
  "appShellOverlay",
  "organizationSwitcher",
  "toolbarButton",
  "contextMenuItem",
  "commentAnnotation",
  "commentContextMenuItem",
  "settingsPage",
  "companySettingsPage"
];
var PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS = [
  "dashboard",
  "onboarding",
  "companies",
  "company",
  "settings",
  "plugins",
  "org",
  "agents",
  "projects",
  "issues",
  "goals",
  "approvals",
  "costs",
  "activity",
  "inbox",
  "workspaces",
  "design-guide",
  "tests"
];
var PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS = [
  "general",
  "environments",
  "access",
  "members",
  "invites",
  "secrets",
  "instance"
];
var PLUGIN_LAUNCHER_PLACEMENT_ZONES = [
  "page",
  "detailTab",
  "taskDetailView",
  "dashboardWidget",
  "sidebar",
  "sidebarPanel",
  "projectSidebarItem",
  "globalToolbarButton",
  "toolbarButton",
  "contextMenuItem",
  "commentAnnotation",
  "commentContextMenuItem",
  "settingsPage"
];
var PLUGIN_LAUNCHER_ACTIONS = [
  "navigate",
  "openModal",
  "openDrawer",
  "openPopover",
  "performAction",
  "deepLink"
];
var PLUGIN_LAUNCHER_BOUNDS = [
  "inline",
  "compact",
  "default",
  "wide",
  "full"
];
var PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS = [
  "hostInline",
  "hostOverlay",
  "hostRoute",
  "external",
  "iframe"
];
var PLUGIN_UI_SLOT_ENTITY_TYPES = [
  "project",
  "issue",
  "agent",
  "goal",
  "run",
  "comment",
  "execution_workspace",
  "project_workspace"
];
var PLUGIN_STATE_SCOPE_KINDS = [
  "instance",
  "company",
  "project",
  "project_workspace",
  "agent",
  "issue",
  "goal",
  "run"
];

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/routine.ts
import { z as z7 } from "zod";

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/types/chat-channels.ts
var CHAT_PROVIDERS = [
  "slack",
  "github",
  "discord",
  "microsoft-teams",
  "telegram",
  "speko",
  "agentmail",
  "imessage-photon"
];

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/task-workspace.ts
import { z } from "zod";
var taskWorkspaceSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task_directory") }).strict(),
  z.object({ kind: z.literal("existing"), workspaceId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("configured_source"), projectWorkspaceId: z.string().uuid(), mode: z.enum(["shared", "managed_isolated"]) }).strict()
]);
var taskWorkspaceIntentSchema = z.object({
  version: z.literal(1),
  request: z.object({ key: z.string().min(1).max(200), expectedBindingRevision: z.number().int().nonnegative() }).strict().optional(),
  selection: taskWorkspaceSelectionSchema,
  source: z.enum(["explicit", "parent", "channel", "project", "operator_cwd", "task_default", "legacy", "recovery"])
}).strict();
var selectTaskWorkspaceSchema = z.object({
  selection: taskWorkspaceSelectionSchema,
  expectedBindingRevision: z.number().int().nonnegative(),
  requestKey: z.string().trim().min(1).max(200)
}).strict();

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/issue.ts
import { z as z5 } from "zod";

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/text.ts
import { z as z2 } from "zod";
function normalizeEscapedLineBreaks(value) {
  if (/[\r\n]/.test(value)) return value;
  return value.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n");
}
var multilineTextSchema = z2.string().transform(normalizeEscapedLineBreaks);

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/trust-policy.ts
import { z as z3 } from "zod";

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/trust-policy.ts
var TRUST_PRESETS = ["standard", "low_trust_review"];
var LOW_TRUST_REVIEW_PRESET = "low_trust_review";
var LOW_TRUST_REVIEW_PRESET_VERSION = 1;
var LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION = "quarantine";

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/trust-policy.ts
var trustPresetSchema = z3.enum(TRUST_PRESETS);
var lowTrustOutputPromotionTargetSchema = z3.object({
  type: z3.literal("issue"),
  issueId: z3.string().guid()
}).strict();
var lowTrustBoundarySchema = z3.object({
  mode: z3.literal(LOW_TRUST_REVIEW_PRESET),
  companyId: z3.string().guid().optional(),
  projectIds: z3.array(z3.string().guid()).optional(),
  rootIssueId: z3.string().guid().optional(),
  issueIds: z3.array(z3.string().guid()).optional(),
  allowedAgentIds: z3.array(z3.string().guid()).optional(),
  allowedSecretBindingIds: z3.array(z3.string().guid()).optional(),
  allowedToolClasses: z3.array(z3.string().trim().min(1)).optional(),
  outputPromotionTarget: lowTrustOutputPromotionTargetSchema.optional()
}).strict();
var lowTrustReviewPresetPolicySchema = z3.object({
  id: z3.literal(LOW_TRUST_REVIEW_PRESET),
  version: z3.literal(LOW_TRUST_REVIEW_PRESET_VERSION),
  rawOutputDisposition: z3.literal(LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION)
}).strict();
var assignmentAuthorizationPolicySchema = z3.object({
  mode: z3.enum(["company_default", "protected"]).optional(),
  // Legacy compatibility only. This remains a hard block and never creates an approval.
  protectedAgentRequiresApproval: z3.boolean().optional()
}).catchall(z3.unknown());
var protectedAgentAuthorizationPolicySchema = z3.object({
  blockAssignment: z3.boolean().optional(),
  blockReason: z3.string().trim().min(1).optional(),
  // Legacy compatibility only. These fields do not create an approval.
  requiresApproval: z3.boolean().optional(),
  approvalReason: z3.string().optional()
}).catchall(z3.unknown());
var trustAuthorizationPolicySchema = z3.object({
  trustPreset: trustPresetSchema.optional(),
  reviewPreset: lowTrustReviewPresetPolicySchema.optional(),
  trustBoundary: lowTrustBoundarySchema.optional(),
  assignmentPolicy: assignmentAuthorizationPolicySchema.optional(),
  protectedAgent: protectedAgentAuthorizationPolicySchema.optional()
}).catchall(z3.unknown());
var sourceTrustArtifactKindSchema = z3.enum(["issue", "comment", "document", "work_product"]);
var sourceTrustMetadataSchema = z3.object({
  preset: trustPresetSchema,
  disposition: z3.enum(["quarantined", "promoted"]),
  sourceIssueId: z3.string().guid().nullable().optional(),
  sourceRunId: z3.string().guid().nullable().optional(),
  sourceAgentId: z3.string().guid().nullable().optional(),
  promotedFrom: z3.object({
    artifactKind: sourceTrustArtifactKindSchema,
    artifactId: z3.string().guid(),
    issueId: z3.string().guid().nullable().optional()
  }).strict().nullable().optional(),
  promotedByActorType: z3.enum(["agent", "user", "system"]).nullable().optional(),
  promotedByActorId: z3.string().trim().min(1).nullable().optional(),
  promotedAt: z3.string().datetime({ offset: true }).nullable().optional()
}).strict();

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/partial.ts
import { z as z4 } from "zod";
function fieldWithoutDefault(field) {
  if (field instanceof z4.ZodDefault) {
    return fieldWithoutDefault(field.unwrap());
  }
  if (field instanceof z4.ZodOptional) {
    return z4.optional(fieldWithoutDefault(field.unwrap()));
  }
  if (field instanceof z4.ZodNullable) {
    return z4.nullable(fieldWithoutDefault(field.unwrap()));
  }
  return field;
}
function shapeWithoutDefaults(shape) {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      fieldWithoutDefault(field)
    ])
  );
}
function objectWithoutDefaults(schema) {
  return z4.object(shapeWithoutDefaults(schema.shape));
}

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/question-set.ts
function syntheticOptionId(existing, preferred) {
  const ids = new Set(existing);
  let candidate = preferred;
  for (let suffix = 2; ids.has(candidate); suffix += 1) candidate = `${preferred}_${suffix}`;
  return candidate;
}
function questionSetToAskUserQuestionsPayload(questionSet) {
  return {
    version: 1,
    ...questionSet.title ? { title: questionSet.title.slice(0, 240) } : {},
    ...questionSet.submitLabel ? { submitLabel: questionSet.submitLabel.slice(0, 120) } : {},
    questionSet,
    questions: questionSet.questions.map((question) => {
      const options = (question.options ?? []).map(({ id, label, description }) => ({
        id,
        label,
        ...description !== void 0 ? { description } : {}
      }));
      const freeTextOption = question.answerMode === "text" ? {
        id: "paperclip_text_answer",
        label: question.header || "Type an answer",
        ...question.textValidation?.inputType ? { description: `Expected ${question.textValidation.inputType} input` } : {},
        freeText: true
      } : question.customAnswer?.enabled ? {
        id: syntheticOptionId(options.map((option) => option.id), "paperclip_custom_answer"),
        label: question.customAnswer.label || "Other",
        ...question.customAnswer.placeholder !== void 0 ? { description: question.customAnswer.placeholder } : {},
        freeText: true
      } : null;
      return {
        id: question.id,
        prompt: question.prompt,
        ...question.helpText || question.header ? { helpText: question.helpText ?? question.header } : {},
        selectionMode: question.answerMode === "multi_select" ? "multi" : "single",
        required: question.required,
        allowOther: freeTextOption !== null,
        options: freeTextOption ? [...options, freeTextOption] : options
      };
    })
  };
}

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/issue.ts
var issueSummariesQuerySchema = z5.object({
  ids: z5.string().transform((value) => value.split(",").map((id) => id.trim().toLowerCase())).pipe(z5.array(z5.string().guid()).min(1).max(ISSUE_SUMMARIES_MAX_IDS)).transform((ids) => [...new Set(ids)])
}).strict();
var issueBlockedInboxStateSchema = z5.enum([
  "needs_attention",
  "awaiting_decision",
  "external_wait",
  "recovery_open",
  "missing_disposition"
]);
var issueBlockedInboxSeveritySchema = z5.enum([
  "critical",
  "high",
  "medium",
  "low"
]);
var issueBlockedInboxReasonSchema = z5.enum([
  "blocked_by_unassigned_issue",
  "blocked_by_assigned_backlog_issue",
  "blocked_by_uninvokable_assignee",
  "blocked_by_cancelled_issue",
  "blocked_chain_stalled",
  "invalid_review_participant",
  "in_review_without_action_path",
  "missing_successful_run_disposition",
  "pending_board_decision",
  "pending_user_decision",
  "external_owner_action",
  "open_recovery_issue"
]);
var issueBlockedInboxIssueRefSchema = z5.object({
  id: z5.string().guid(),
  identifier: z5.string().nullable(),
  title: z5.string(),
  status: z5.enum(ISSUE_STATUSES),
  priority: z5.enum(ISSUE_PRIORITIES),
  assigneeAgentId: z5.string().guid().nullable(),
  assigneeUserId: z5.string().nullable()
}).strict();
var issueBlockedInboxAttentionSchema = z5.object({
  kind: z5.literal("blocked"),
  state: issueBlockedInboxStateSchema,
  reason: issueBlockedInboxReasonSchema,
  severity: issueBlockedInboxSeveritySchema,
  stoppedSinceAt: z5.string().datetime().nullable(),
  owner: z5.object({
    type: z5.enum(["agent", "user", "board", "external", "unknown"]),
    agentId: z5.string().guid().nullable(),
    userId: z5.string().nullable(),
    label: z5.string().nullable()
  }).strict(),
  action: z5.object({
    label: z5.string().trim().min(1),
    detail: z5.string().nullable()
  }).strict(),
  sourceIssue: issueBlockedInboxIssueRefSchema.nullable(),
  leafIssue: issueBlockedInboxIssueRefSchema.nullable(),
  recoveryIssue: issueBlockedInboxIssueRefSchema.nullable(),
  approvalId: z5.string().guid().nullable(),
  interactionId: z5.string().guid().nullable(),
  sampleIssueIdentifier: z5.string().nullable(),
  redaction: z5.object({
    externalDetailsRedacted: z5.boolean(),
    secretFieldsOmitted: z5.literal(true)
  }).strict()
}).strict();
var ISSUE_EXECUTION_WORKSPACE_PREFERENCES = [
  "inherit",
  "shared_workspace",
  "isolated_workspace",
  "operator_branch",
  "reuse_existing",
  "agent_default"
];
function isValidExistingBranchName(value) {
  if (value.length === 0 || value.length > 255) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.startsWith("."))
    return false;
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock"))
    return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{") || value.includes("/."))
    return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(value)) return false;
  return true;
}
var executionWorkspaceStrategySchema = z5.object({
  type: z5.enum([
    "project_primary",
    "git_worktree",
    "adapter_managed",
    "cloud_sandbox"
  ]).optional(),
  baseRef: z5.string().optional().nullable(),
  branchTemplate: z5.string().optional().nullable(),
  existingBranch: z5.string().trim().refine(isValidExistingBranchName, {
    message: "existingBranch must be a valid git branch name"
  }).optional().nullable(),
  worktreeParentDir: z5.string().optional().nullable(),
  provisionCommand: z5.string().optional().nullable(),
  runtimeProvisionCommand: z5.string().optional().nullable(),
  teardownCommand: z5.string().optional().nullable()
}).strict().superRefine((strategy, ctx) => {
  if (!strategy.existingBranch) return;
  if (strategy.type !== "git_worktree") {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      path: ["existingBranch"],
      message: 'existingBranch requires workspaceStrategy.type "git_worktree"'
    });
  }
  if (strategy.branchTemplate) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      path: ["existingBranch"],
      message: "existingBranch and branchTemplate are mutually exclusive"
    });
  }
});
var ipv4CidrPattern = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\/(?:3[0-2]|[12]?\d)$/;
var protectedTaskEgressCidrs = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4"
];
function ipv4CidrRange(cidr) {
  if (!ipv4CidrPattern.test(cidr)) return null;
  const [address, prefixText] = cidr.split("/");
  const addressValue = address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
  const prefix = Number(prefixText);
  const blockSize = 2 ** (32 - prefix);
  const start = Math.floor(addressValue / blockSize) * blockSize;
  return [start, start + blockSize - 1];
}
function isAllowedTaskEgressCidr(cidr) {
  const range = ipv4CidrRange(cidr);
  if (!range) return false;
  return protectedTaskEgressCidrs.every((protectedCidr) => {
    const protectedRange = ipv4CidrRange(protectedCidr);
    return protectedRange !== null && (range[1] < protectedRange[0] || range[0] > protectedRange[1]);
  });
}
var issueExecutionWorkspaceSettingsSchema = z5.object({
  mode: z5.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional(),
  sharedWorkspaceConcurrency: z5.enum(["auto", "serialize", "allow"]).optional(),
  environmentId: z5.string().guid().optional().nullable(),
  workspaceStrategy: executionWorkspaceStrategySchema.optional().nullable(),
  workspaceRuntime: z5.record(z5.string(), z5.unknown()).optional().nullable(),
  networkEgress: z5.object({
    allowFqdns: z5.array(
      z5.string().trim().toLowerCase().regex(
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
        "Network egress FQDNs must be hostnames without a URL scheme or path"
      ).max(253)
    ).max(100).optional(),
    allowCidrs: z5.array(
      z5.string().trim().regex(
        ipv4CidrPattern,
        "Invalid IPv4 CIDR (must use octets 0-255 and prefix 0-32)"
      ).max(64).refine(
        isAllowedTaskEgressCidr,
        "Task-scoped network egress CIDRs cannot overlap private, loopback, link-local, CGNAT, or multicast ranges"
      )
    ).max(100).optional()
  }).strict().optional().nullable()
}).strict().superRefine((settings, ctx) => {
  if (settings.workspaceStrategy?.existingBranch && settings.mode !== "isolated_workspace") {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      path: ["workspaceStrategy", "existingBranch"],
      message: 'existingBranch requires mode "isolated_workspace"'
    });
  }
});
var issueAssigneeAdapterOverridesSchema = z5.object({
  adapterConfig: z5.record(z5.string(), z5.unknown()).refine((config) => !Object.prototype.hasOwnProperty.call(config, "homeMode"), "homeMode must be set by an operator on the agent, not on a task").refine((config) => !config.env || typeof config.env !== "object" || !Object.keys(config.env).some((key) => key.toUpperCase() === "PAPERCLIP_RUNNER_PREPARED_HARNESS_HOME"), "Prepared harness homes must be provisioned by the execution environment, not on a task").optional(),
  useProjectWorkspace: z5.boolean().optional()
}).strict();
var issueExecutionStagePrincipalBaseSchema = z5.object({
  type: z5.enum(["agent", "user"]),
  agentId: z5.string().guid().optional().nullable(),
  userId: z5.string().optional().nullable()
});
var issueExecutionStagePrincipalSchema = issueExecutionStagePrincipalBaseSchema.superRefine((value, ctx) => {
  if (value.type === "agent") {
    if (!value.agentId) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "Agent participants require agentId",
        path: ["agentId"]
      });
    }
    if (value.userId) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "Agent participants cannot set userId",
        path: ["userId"]
      });
    }
    return;
  }
  if (!value.userId) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "User participants require userId",
      path: ["userId"]
    });
  }
  if (value.agentId) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "User participants cannot set agentId",
      path: ["agentId"]
    });
  }
});
var issueExecutionStageParticipantSchema = issueExecutionStagePrincipalBaseSchema.extend({
  id: z5.string().guid().optional()
}).superRefine((value, ctx) => {
  if (value.type === "agent") {
    if (!value.agentId) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "Agent participants require agentId",
        path: ["agentId"]
      });
    }
    if (value.userId) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "Agent participants cannot set userId",
        path: ["userId"]
      });
    }
    return;
  }
  if (!value.userId) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "User participants require userId",
      path: ["userId"]
    });
  }
  if (value.agentId) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "User participants cannot set agentId",
      path: ["agentId"]
    });
  }
});
var issueExecutionStageSchema = z5.object({
  id: z5.string().guid().optional(),
  type: z5.enum(ISSUE_EXECUTION_STAGE_TYPES),
  approvalsNeeded: z5.literal(1).optional().default(1),
  participants: z5.array(issueExecutionStageParticipantSchema).default([])
});
var issueExecutionMonitorPolicySchema = z5.object({
  nextCheckAt: z5.string().datetime(),
  notes: z5.string().max(500).optional().nullable().default(null),
  scheduledBy: z5.enum(ISSUE_MONITOR_SCHEDULED_BY).optional().default("assignee"),
  kind: z5.enum(ISSUE_EXECUTION_MONITOR_KINDS).optional().nullable().default(null),
  serviceName: z5.string().trim().min(1).max(120).optional().nullable().default(null),
  externalRef: z5.string().trim().min(1).max(500).optional().nullable().default(null),
  timeoutAt: z5.string().datetime().optional().nullable().default(null),
  maxAttempts: z5.number().int().positive().max(100).optional().nullable().default(null),
  recoveryPolicy: z5.enum(ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES).optional().nullable().default(null)
});
var requiredQualityReviewSchema = z5.object({
  version: z5.literal(1),
  deliverables: z5.array(z5.object({
    key: z5.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
    label: z5.string().trim().min(1).max(120)
  }).strict()).min(1).max(10)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.deliverables.map((item) => item.key)).size !== value.deliverables.length)
    ctx.addIssue({ code: z5.ZodIssueCode.custom, message: "Quality review deliverable keys must be unique", path: ["deliverables"] });
});
var issueExecutionPolicySchema = z5.object({
  requiredQualityReview: requiredQualityReviewSchema.optional(),
  mode: z5.enum(ISSUE_EXECUTION_POLICY_MODES).optional().default("normal"),
  commentRequired: z5.boolean().optional().default(true),
  stages: z5.array(issueExecutionStageSchema).default([]),
  monitor: issueExecutionMonitorPolicySchema.optional().nullable(),
  reviewPreset: lowTrustReviewPresetPolicySchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
  maxReviewRounds: z5.number().int().positive().max(50).optional().nullable().default(null)
});
var issueExecutionMonitorStateSchema = z5.object({
  status: z5.enum(ISSUE_EXECUTION_MONITOR_STATE_STATUSES),
  nextCheckAt: z5.string().datetime().nullable(),
  lastTriggeredAt: z5.string().datetime().nullable(),
  attemptCount: z5.number().int().nonnegative().default(0),
  notes: z5.string().max(500).nullable(),
  scheduledBy: z5.enum(ISSUE_MONITOR_SCHEDULED_BY).nullable(),
  kind: z5.enum(ISSUE_EXECUTION_MONITOR_KINDS).nullable().optional().default(null),
  serviceName: z5.string().trim().min(1).max(120).nullable().optional().default(null),
  externalRef: z5.string().trim().min(1).max(500).nullable().optional().default(null),
  timeoutAt: z5.string().datetime().nullable().optional().default(null),
  maxAttempts: z5.number().int().positive().max(100).nullable().optional().default(null),
  recoveryPolicy: z5.enum(ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES).nullable().optional().default(null),
  clearedAt: z5.string().datetime().nullable(),
  clearReason: z5.enum(ISSUE_EXECUTION_MONITOR_CLEAR_REASONS).nullable()
});
var issueReviewRequestSchema = z5.object({
  instructions: z5.string().trim().min(1).max(2e4)
}).strict();
var issueExecutionStateSchema = z5.object({
  status: z5.enum(ISSUE_EXECUTION_STATE_STATUSES),
  currentStageId: z5.string().guid().nullable(),
  currentStageIndex: z5.number().int().nonnegative().nullable(),
  currentStageType: z5.enum(ISSUE_EXECUTION_STAGE_TYPES).nullable(),
  currentParticipant: issueExecutionStagePrincipalSchema.nullable(),
  returnAssignee: issueExecutionStagePrincipalSchema.nullable(),
  reviewRequest: issueReviewRequestSchema.nullable().optional().default(null),
  completedStageIds: z5.array(z5.string().guid()).default([]),
  lastDecisionId: z5.string().guid().nullable(),
  lastDecisionOutcome: z5.enum(ISSUE_EXECUTION_DECISION_OUTCOMES).nullable(),
  monitor: issueExecutionMonitorStateSchema.optional().nullable(),
  changesRequestedCount: z5.number().int().nonnegative().optional().default(0)
});
var issueRecoveryActionReadModelSchema = z5.object({
  id: z5.string().guid(),
  companyId: z5.string().guid(),
  sourceIssueId: z5.string().guid(),
  recoveryIssueId: z5.string().guid().nullable(),
  kind: z5.enum(ISSUE_RECOVERY_ACTION_KINDS),
  status: z5.enum(ISSUE_RECOVERY_ACTION_STATUSES),
  ownerType: z5.enum(ISSUE_RECOVERY_ACTION_OWNER_TYPES),
  ownerAgentId: z5.string().guid().nullable(),
  ownerUserId: z5.string().nullable(),
  previousOwnerAgentId: z5.string().guid().nullable(),
  returnOwnerAgentId: z5.string().guid().nullable(),
  cause: z5.string().min(1),
  fingerprint: z5.string().min(1),
  evidence: z5.record(z5.string(), z5.unknown()),
  nextAction: z5.string().min(1),
  wakePolicy: z5.record(z5.string(), z5.unknown()).nullable(),
  monitorPolicy: z5.record(z5.string(), z5.unknown()).nullable(),
  attemptCount: z5.number().int().nonnegative(),
  maxAttempts: z5.number().int().positive().nullable(),
  timeoutAt: z5.union([z5.date(), z5.string().datetime()]).nullable(),
  lastAttemptAt: z5.union([z5.date(), z5.string().datetime()]).nullable(),
  outcome: z5.enum(ISSUE_RECOVERY_ACTION_OUTCOMES).nullable(),
  resolutionNote: z5.string().nullable(),
  resolvedAt: z5.union([z5.date(), z5.string().datetime()]).nullable(),
  createdAt: z5.union([z5.date(), z5.string().datetime()]),
  updatedAt: z5.union([z5.date(), z5.string().datetime()])
});
var RESOLVE_ISSUE_RECOVERY_ACTION_OUTCOMES = [
  "restored",
  "false_positive",
  "blocked",
  "cancelled"
];
var resumeWorkspaceFinalizationSchema = z5.object({
  actionId: z5.string().guid(),
  runId: z5.string().guid(),
  ownerToken: z5.string().guid(),
  controllerAndCopybackStopped: z5.literal(true),
  stopEvidence: z5.string().trim().min(20).max(12e3)
}).strict();
var retryWorkspaceExportSchema = z5.object({
  actionId: z5.string().guid(),
  runId: z5.string().guid(),
  repairNote: z5.string().trim().min(20).max(12e3)
}).strict();
var taskRetrySchema = z5.object({
  idempotencyKey: z5.string().guid(),
  observedRunId: z5.string().guid().nullable()
}).strict();
var recoverWorkspaceSchema = z5.object({
  actionId: z5.string().guid(),
  runId: z5.string().guid(),
  idempotencyKey: z5.string().guid()
}).strict();
var reconstructWorkspaceSchema = z5.object({
  actionId: z5.string().guid(),
  runId: z5.string().guid(),
  expectedStatusVersion: z5.number().int().nonnegative(),
  attachmentIds: z5.array(z5.string().guid()).min(1).max(20).refine((ids) => new Set(ids).size === ids.length),
  missingWork: z5.string().trim().min(20).max(12e3),
  actionOutcome: z5.enum(["completed", "not_performed", "mixed"]),
  outcomeEvidence: z5.string().trim().min(20).max(12e3),
  acknowledgeLostWork: z5.literal(true)
}).strict();
var resolveIssueRecoveryActionSchema = z5.object({
  workspaceBaseRef: z5.object({
    requestedRef: z5.string().trim().min(1).max(1024),
    branch: z5.string().trim().refine(isValidExistingBranchName, { message: "Choose a valid Git branch name" })
  }).strict().optional(),
  executionReconciliation: z5.object({
    runId: z5.string().guid(),
    providerStopped: z5.literal(true),
    actionOutcome: z5.enum(["completed", "not_performed", "mixed"]),
    outcomeEvidence: z5.string().trim().min(20).max(12e3),
    workspaceRepairEvidence: z5.string().trim().min(20).max(12e3).optional()
  }).strict().optional(),
  actionId: z5.string().guid().optional(),
  outcome: z5.enum(RESOLVE_ISSUE_RECOVERY_ACTION_OUTCOMES),
  sourceIssueStatus: z5.enum(ISSUE_STATUSES),
  resolutionNote: multilineTextSchema.optional().nullable()
}).strict().superRefine((value, ctx) => {
  if (value.workspaceBaseRef && (!value.actionId || value.outcome !== "restored" || value.sourceIssueStatus !== "todo" || value.executionReconciliation)) {
    ctx.addIssue({ code: z5.ZodIssueCode.custom, path: ["workspaceBaseRef"], message: "Branch repair must retry the exact recovery action" });
  }
  if (value.outcome === "restored") {
    if (value.executionReconciliation?.workspaceRepairEvidence) return;
    if (value.sourceIssueStatus !== "todo" && value.sourceIssueStatus !== "done" && value.sourceIssueStatus !== "in_review") {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "Restored recovery actions must move the source issue to todo, done, or in_review",
        path: ["sourceIssueStatus"]
      });
    }
    return;
  }
  if (value.outcome === "blocked") {
    if (value.sourceIssueStatus !== "blocked") {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "Blocked recovery actions must move the source issue to blocked",
        path: ["sourceIssueStatus"]
      });
    }
    return;
  }
  if (value.outcome === "false_positive" || value.outcome === "cancelled") {
    if (value.sourceIssueStatus !== "done" && value.sourceIssueStatus !== "in_review") {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "This recovery outcome requires sourceIssueStatus to be done or in_review",
        path: ["sourceIssueStatus"]
      });
    }
    return;
  }
});
var issueRequestDepthInputSchema = z5.number().int().nonnegative().transform((value) => clampIssueRequestDepth(value));
function resolveCreateIssueStatusDefault(input) {
  if (typeof input.status === "string") {
    return {
      status: input.status,
      defaulted: false,
      reason: "explicit"
    };
  }
  const hasAssignee = typeof input.assigneeAgentId === "string" && input.assigneeAgentId.length > 0 || typeof input.assigneeUserId === "string" && input.assigneeUserId.length > 0;
  return {
    status: hasAssignee ? "todo" : "backlog",
    defaulted: true,
    reason: hasAssignee ? "assigned_omitted_status" : "unassigned_omitted_status"
  };
}
function withCreateIssueStatusDefault(schema) {
  return z5.preprocess((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return input;
    const raw = input;
    if (raw.status !== void 0) return input;
    return {
      ...raw,
      status: resolveCreateIssueStatusDefault(raw).status
    };
  }, schema);
}
var createIssueBaseSchema = z5.object({
  projectId: z5.string().guid().optional().nullable(),
  projectWorkspaceId: z5.string().guid().optional().nullable(),
  goalId: z5.string().guid().optional().nullable(),
  visibility: z5.enum(["open", "private"]).optional().default("open"),
  parentId: z5.string().guid().optional().nullable(),
  blockedByIssueIds: z5.array(z5.string().guid()).optional(),
  unblockDescriptor: z5.object({
    owner: z5.union([
      z5.object({ agentId: z5.string().guid() }).strict(),
      z5.object({ userId: z5.string().trim().min(1) }).strict(),
      z5.literal("board")
    ]),
    action: multilineTextSchema.pipe(z5.string().trim().min(1).max(2e3))
  }).strict().optional().nullable(),
  inheritExecutionWorkspaceFromIssueId: z5.string().guid().optional().nullable(),
  title: z5.string().min(1),
  description: multilineTextSchema.optional().nullable(),
  status: z5.enum(ISSUE_STATUSES),
  workMode: z5.enum(ISSUE_WORK_MODES).optional().default("standard"),
  harnessKind: z5.enum(ISSUE_HARNESS_KINDS).optional().nullable(),
  priority: z5.enum(ISSUE_PRIORITIES).optional().default("medium"),
  reviewPolicy: z5.enum(ISSUE_REVIEW_POLICIES).optional().nullable(),
  assigneeAgentId: z5.string().guid().optional().nullable(),
  assigneeUserId: z5.string().optional().nullable(),
  requestDepth: issueRequestDepthInputSchema.optional().default(0),
  createdByUserId: z5.string().optional().nullable(),
  responsibleUserId: z5.string().optional().nullable(),
  billingCode: z5.string().optional().nullable(),
  assigneeAdapterOverrides: issueAssigneeAdapterOverridesSchema.optional().nullable(),
  executionPolicy: issueExecutionPolicySchema.optional().nullable(),
  executionWorkspaceId: z5.string().guid().optional().nullable(),
  executionWorkspacePreference: z5.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional().nullable(),
  workspaceSelection: taskWorkspaceSelectionSchema.optional(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.optional().nullable(),
  labelIds: z5.array(z5.string().guid()).optional(),
  watchdogDiscovery: z5.object({
    kind: z5.enum(ISSUE_WATCHDOG_DISCOVERY_KINDS),
    evidenceMarkdown: multilineTextSchema.optional().nullable()
  }).strict().optional().nullable(),
  watchdog: z5.object({
    agentId: z5.string().guid(),
    instructions: multilineTextSchema.optional().nullable()
  }).strict().optional().nullable()
});
function requireBlockedStatusForUnblockDescriptor(value, ctx) {
  if (value.unblockDescriptor != null && value.status !== void 0 && value.status !== "blocked") {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "unblockDescriptor requires blocked status",
      path: ["unblockDescriptor"]
    });
  }
}
var createIssueDuplicateGuardSchema = {
  initialPlan: z5.string().min(1).max(2e5).optional().nullable(),
  idempotencyKey: z5.string().trim().min(1).max(255).optional().nullable(),
  allowDuplicate: z5.boolean().describe(
    "Bypasses recent-title duplicate detection; idempotency keys always replay their original issue"
  ).optional().default(false)
};
var onboardingFirstTaskMarkerSchema = {
  onboardingFirstTask: z5.boolean().optional()
};
var createIssueInputSchema = createIssueBaseSchema.extend({
  title: z5.string().optional(),
  status: createIssueBaseSchema.shape.status.optional(),
  ...createIssueDuplicateGuardSchema,
  ...onboardingFirstTaskMarkerSchema
});
function requireTitleOrDescription(value, ctx) {
  if (!value.title?.trim() && !value.description?.trim()) {
    ctx.addIssue({ code: z5.ZodIssueCode.custom, path: ["title"], message: "Provide a title or task description" });
  }
}
var createIssueSchema = withCreateIssueStatusDefault(
  createIssueBaseSchema.extend({
    title: z5.string().optional(),
    ...createIssueDuplicateGuardSchema,
    ...onboardingFirstTaskMarkerSchema
  })
).superRefine(requireBlockedStatusForUnblockDescriptor).superRefine(requireTitleOrDescription);
var setIssueTitleSchema = z5.object({
  title: z5.string().trim().min(1).max(240),
  onlyIfProvisional: z5.boolean().optional().default(false),
  idempotencyKey: z5.string().trim().min(1).max(240).optional()
}).strict();
var upsertIssueWatchdogSchema = z5.object({
  agentId: z5.string().guid(),
  instructions: multilineTextSchema.optional().nullable()
}).strict();
var createChildIssueSchema = withCreateIssueStatusDefault(
  createIssueBaseSchema.omit({
    parentId: true,
    inheritExecutionWorkspaceFromIssueId: true,
    watchdogDiscovery: true
  }).extend({
    title: z5.string().optional(),
    acceptanceCriteria: z5.array(z5.string().trim().min(1).max(500)).max(20).optional(),
    blockParentUntilDone: z5.boolean().optional().default(false)
  })
).superRefine(requireBlockedStatusForUnblockDescriptor).superRefine(requireTitleOrDescription);
var createAcceptedPlanDecompositionSchema = z5.object({
  acceptedPlanRevisionId: z5.string().guid(),
  children: z5.array(createChildIssueSchema).min(1).max(25)
});
var createIssueLabelSchema = z5.object({
  name: z5.string().trim().min(1).max(48),
  color: z5.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value")
});
var issueCommentAttachmentIdsSchema = z5.array(z5.string().uuid()).max(20).refine((ids) => new Set(ids).size === ids.length, {
  message: "Attachment ids must be unique"
});
var updateIssueSchema = objectWithoutDefaults(
  createIssueBaseSchema.omit({
    workspaceSelection: true,
    createdByUserId: true,
    responsibleUserId: true,
    watchdog: true
  })
).partial().extend({
  expectedStatusVersion: z5.number().int().nonnegative().optional(),
  /** Reject a policy write if the policy changed after the caller read it. */
  expectedExecutionPolicy: z5.record(z5.string(), z5.unknown()).optional().nullable(),
  requestDepth: issueRequestDepthInputSchema.optional(),
  assigneeAgentId: z5.string().trim().min(1).optional().nullable(),
  comment: multilineTextSchema.pipe(z5.string().min(1)).optional(),
  commentClientRequestId: z5.string().uuid().optional(),
  /** Only valid with a comment; the route binds these in the update transaction. */
  attachmentIds: issueCommentAttachmentIdsSchema.optional(),
  onBehalfOfUserId: z5.string().trim().min(1).optional().nullable(),
  reviewInteractionId: z5.string().guid().optional(),
  reviewRequest: issueReviewRequestSchema.optional().nullable(),
  reopen: z5.boolean().optional(),
  resume: z5.boolean().optional(),
  interrupt: z5.boolean().optional(),
  /** Assignment-only handoff; the following structured goal action owns the wake. */
  deferWakeForGoal: z5.boolean().optional(),
  hiddenAt: z5.string().datetime().nullable().optional()
});
var stalledReviewDecisionSchema = z5.object({
  action: z5.enum(["approve", "request_changes", "send_back"]),
  note: multilineTextSchema.pipe(z5.string().min(1)).optional()
}).strict().superRefine((value, ctx) => {
  if (value.action === "request_changes" && !value.note?.trim()) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      path: ["note"],
      message: "Request changes requires a note"
    });
  }
});
var checkoutIssueSchema = z5.object({
  agentId: z5.string().guid(),
  expectedStatuses: z5.array(z5.enum(ISSUE_STATUSES)).nonempty()
});
var commentMetadataLabelSchema = z5.string().trim().min(1).max(120);
var commentMetadataTextSchema = z5.string().trim().min(1).max(2e3);
var issueCommentAuthorTypeSchema = z5.enum(ISSUE_COMMENT_AUTHOR_TYPES);
var issueCommentPresentationSchema = z5.object({
  kind: z5.enum(ISSUE_COMMENT_PRESENTATION_KINDS).default("message"),
  tone: z5.enum(ISSUE_COMMENT_PRESENTATION_TONES).default("neutral"),
  title: z5.string().trim().min(1).max(160).nullable().optional(),
  detailsDefaultOpen: z5.boolean().optional().default(false),
  density: z5.enum(ISSUE_COMMENT_PRESENTATION_DENSITIES).optional()
}).strict();
var issueCommentMetadataBaseRowSchema = z5.object({
  type: z5.enum(ISSUE_COMMENT_METADATA_ROW_TYPES),
  label: commentMetadataLabelSchema.nullable().optional()
});
var issueCommentMetadataTextRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z5.literal("text"),
  text: commentMetadataTextSchema
}).strict();
var issueCommentMetadataCodeRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z5.literal("code"),
  code: z5.string().min(1).max(4e3),
  language: z5.string().trim().min(1).max(40).nullable().optional()
}).strict();
var issueCommentMetadataKeyValueRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z5.literal("key_value"),
  label: commentMetadataLabelSchema,
  value: commentMetadataTextSchema
}).strict();
var issueCommentMetadataIssueLinkRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z5.literal("issue_link"),
  issueId: z5.string().guid().nullable().optional(),
  identifier: z5.string().trim().min(1).max(80).nullable().optional(),
  title: z5.string().trim().min(1).max(240).nullable().optional()
}).strict();
var issueCommentMetadataAgentLinkRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z5.literal("agent_link"),
  agentId: z5.string().guid(),
  name: z5.string().trim().min(1).max(160).nullable().optional()
}).strict();
var issueCommentMetadataRunLinkRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z5.literal("run_link"),
  runId: z5.string().guid(),
  agentId: z5.string().guid().nullable().optional(),
  title: z5.string().trim().min(1).max(160).nullable().optional()
}).strict();
var issueCommentMetadataRowSchema = z5.discriminatedUnion("type", [
  issueCommentMetadataTextRowSchema,
  issueCommentMetadataCodeRowSchema,
  issueCommentMetadataKeyValueRowSchema,
  issueCommentMetadataIssueLinkRowSchema,
  issueCommentMetadataAgentLinkRowSchema,
  issueCommentMetadataRunLinkRowSchema
]).superRefine((value, ctx) => {
  if (value.type === "issue_link" && !value.issueId && !value.identifier) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "Issue link rows require issueId or identifier",
      path: ["issueId"]
    });
  }
});
var issueCommentMetadataSectionSchema = z5.object({
  title: z5.string().trim().min(1).max(160).nullable().optional(),
  rows: z5.array(issueCommentMetadataRowSchema).min(1).max(50)
}).strict();
var issueCommentMetadataSchema = z5.object({
  version: z5.literal(1),
  recoveryResponsibility: z5.enum(["system", "user"]).optional(),
  sourceChannel: z5.enum(CHAT_PROVIDERS).optional(),
  sourceRunId: z5.string().guid().nullable().optional(),
  authorizationReason: z5.string().trim().min(1).max(160).nullable().optional(),
  recovery: z5.object({
    kind: z5.literal("disposition_repair_escalated"),
    actionId: z5.string().guid(),
    attemptCount: z5.number().int().nonnegative(),
    maxAttempts: z5.number().int().positive(),
    reason: z5.string().trim().min(1).max(160),
    assigneeAgentId: z5.string().guid().nullable()
  }).strict().optional(),
  sections: z5.array(issueCommentMetadataSectionSchema).min(1).max(20)
}).strict();
var addIssueCommentSchema = z5.object({
  clientRequestId: z5.string().uuid().optional(),
  body: multilineTextSchema.pipe(z5.string().min(1)),
  attachmentIds: issueCommentAttachmentIdsSchema.optional(),
  onBehalfOfUserId: z5.string().trim().min(1).optional().nullable(),
  authorType: issueCommentAuthorTypeSchema.optional(),
  presentation: issueCommentPresentationSchema.nullable().optional(),
  metadata: issueCommentMetadataSchema.nullable().optional(),
  reopen: z5.boolean().optional(),
  resume: z5.boolean().optional(),
  interrupt: z5.boolean().optional()
});
var issueThreadInteractionStatusSchema = z5.enum(
  ISSUE_THREAD_INTERACTION_STATUSES
);
var issueThreadInteractionKindSchema = z5.enum(
  ISSUE_THREAD_INTERACTION_KINDS
);
var issueThreadInteractionCanonicalResolverPolicySchema = z5.enum(ISSUE_THREAD_INTERACTION_CANONICAL_RESOLVER_POLICIES).describe("Canonical resolver audience: anyone, not_creator, or human_only.");
var issueThreadInteractionResolverPolicySchema = z5.enum(ISSUE_THREAD_INTERACTION_RESOLVER_POLICIES).describe(
  "Resolver audience. Use anyone, not_creator, or human_only; board_or_agents and board_only are deprecated compatibility aliases."
);
var issueThreadInteractionResolverPolicyProvenanceSchema = z5.enum(
  ISSUE_THREAD_INTERACTION_RESOLVER_POLICY_PROVENANCES
);
var issueThreadInteractionEffectiveResolverPolicySourceSchema = z5.enum(
  ISSUE_THREAD_INTERACTION_EFFECTIVE_RESOLVER_POLICY_SOURCES
);
var issueThreadInteractionContinuationPolicySchema = z5.enum(
  ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES
);
var connectionIntentPhaseSchema = z5.enum([
  "requested",
  "authorizing",
  "needs_retry"
]);
var connectionIntentBrandAssetSchema = z5.string().max(2048).refine((value) => {
  if (/^\/brands\/apps\/[a-z0-9][a-z0-9._-]*\.(?:svg|png)$/i.test(value))
    return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "Connection intent brand assets must be HTTPS URLs or local app brand paths");
var connectionIntentPayloadSchema = z5.object({
  savedSetup: z5.object({ endpointId: z5.string().guid(), connectionId: z5.string().guid(), action: z5.enum(["enter_credentials", "rotate_credentials", "confirm_identity"]).optional(), credentialRotation: z5.object({ previousId: z5.string().guid().nullable() }).strict().optional(), credentialEntry: z5.object({
    previousGenerations: z5.record(z5.string().refine((field) => ["signingSecret", "webhookSecret", "privateKey", "clientSecret", "projectSecret"].includes(field)), z5.string().uuid().nullable()).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 5),
    requireAll: z5.boolean()
  }).strict().optional() }).strict().refine((value) => value.action !== "rotate_credentials" || !!value.credentialRotation, "Rotation requests need a completion boundary").optional(),
  accessRequest: z5.object({
    connectionId: z5.string().guid(),
    connectionName: z5.string().trim().min(1).max(160),
    tools: z5.array(z5.object({
      catalogEntryId: z5.string().guid(),
      toolName: z5.string().trim().min(1).max(160),
      versionHash: z5.string().min(1).max(256),
      permission: z5.enum(["allowed", "ask_first"])
    }).strict()).min(1).max(20).refine((tools) => new Set(tools.map((tool) => tool.catalogEntryId)).size === tools.length, "Requested tools must be unique")
  }).strict().optional(),
  upstreamService: z5.object({ slug: z5.string().min(1).max(120), name: z5.string().min(1).max(160), selectionInteractionId: z5.string().guid().optional() }).strict().optional(),
  purpose: z5.enum(["ai", "channel"]).optional(),
  version: z5.literal(1),
  serviceSlug: z5.string().trim().min(1).max(120),
  serviceName: z5.string().trim().min(1).max(160),
  serviceLogoUrl: connectionIntentBrandAssetSchema.nullable().optional(),
  serviceDarkLogoUrl: connectionIntentBrandAssetSchema.nullable().optional(),
  requestingAgentId: z5.string().guid(),
  requestingAgentName: z5.string().trim().min(1).max(160),
  phase: connectionIntentPhaseSchema
}).strict();
var connectionIntentResultSchema = z5.object({
  version: z5.literal(1),
  instruction: z5.string().max(4e3).optional(),
  outcome: z5.enum(["connected", "declined", "superseded", "expired"]),
  connectionId: z5.string().guid().nullable().optional(),
  reason: z5.string().trim().max(4e3).nullable().optional(),
  supersededByInteractionId: z5.string().guid().nullable().optional()
}).strict().superRefine((value, ctx) => {
  if (value.outcome === "connected" && !value.connectionId) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      path: ["connectionId"],
      message: "Connected intents require a connection id"
    });
  }
  if (value.outcome === "superseded" && !value.supersededByInteractionId) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      path: ["supersededByInteractionId"],
      message: "Superseded intents require the replacement interaction id"
    });
  }
});
var issueDocumentKeySchema = z5.string().trim().min(1).max(64).regex(
  /^[a-z0-9][a-z0-9_-]*$/,
  "Document key must be lowercase letters, numbers, _ or -"
);
var suggestedTaskDraftSchema = z5.object({
  clientKey: z5.string().trim().min(1).max(120),
  parentClientKey: z5.string().trim().min(1).max(120).nullable().optional(),
  parentId: z5.string().guid().nullable().optional(),
  title: z5.string().trim().min(1).max(240),
  description: multilineTextSchema.pipe(z5.string().trim().max(2e4)).nullable().optional(),
  initialPlan: z5.string().trim().min(1).max(2e5).nullable().optional(),
  requiredQualityReview: requiredQualityReviewSchema.optional(),
  priority: z5.enum(ISSUE_PRIORITIES).nullable().optional(),
  workMode: z5.enum(ISSUE_WORK_MODES).nullable().optional(),
  assigneeAgentId: z5.string().guid().nullable().optional(),
  assigneeUserId: z5.string().trim().min(1).nullable().optional(),
  projectId: z5.string().guid().nullable().optional(),
  goalId: z5.string().guid().nullable().optional(),
  billingCode: z5.string().trim().max(120).nullable().optional(),
  labels: z5.array(z5.string().trim().min(1).max(48)).max(20).optional(),
  hiddenInPreview: z5.boolean().optional()
}).superRefine((value, ctx) => {
  if (value.assigneeAgentId && value.assigneeUserId) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "Suggested tasks can only target one assignee",
      path: ["assigneeAgentId"]
    });
  }
});
var suggestTasksPayloadSchema = z5.object({
  version: z5.literal(1),
  defaultParentId: z5.string().guid().nullable().optional(),
  tasks: z5.array(suggestedTaskDraftSchema).min(1).max(50)
}).superRefine((value, ctx) => {
  const seenClientKeys = /* @__PURE__ */ new Set();
  for (const [index, task] of value.tasks.entries()) {
    if (seenClientKeys.has(task.clientKey)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "clientKey must be unique within one interaction",
        path: ["tasks", index, "clientKey"]
      });
      continue;
    }
    seenClientKeys.add(task.clientKey);
  }
});
var suggestTasksResultCreatedTaskSchema = z5.object({
  clientKey: z5.string().trim().min(1).max(120),
  issueId: z5.string().guid(),
  identifier: z5.string().trim().min(1).nullable().optional(),
  title: z5.string().trim().min(1).nullable().optional(),
  parentIssueId: z5.string().guid().nullable().optional(),
  parentIdentifier: z5.string().trim().min(1).nullable().optional()
});
var suggestTasksResultSchema = z5.object({
  version: z5.literal(1),
  outcome: z5.enum(["skipped", "withdrawn", "issue_closed", "addressee_deleted"]).optional(),
  reason: z5.string().trim().max(4e3).nullable().optional(),
  createdTasks: z5.array(suggestTasksResultCreatedTaskSchema).max(50).optional(),
  skippedClientKeys: z5.array(z5.string().trim().min(1).max(120)).max(50).optional(),
  rejectionReason: z5.string().trim().max(4e3).nullable().optional()
});
var askUserQuestionsQuestionOptionSchema = z5.object({
  id: z5.string().trim().min(1).max(160),
  label: z5.string().trim().min(1).max(1e3),
  description: z5.string().trim().max(4e3).nullable().optional(),
  freeText: z5.boolean().optional().describe(
    `When true, selecting this option reveals an inline text field; the typed value is returned as the question's otherText. Use this for a real "I'll describe it" choice instead of authoring a dead option that does nothing. At most one free-text option per question.`
  )
});
var askUserQuestionsQuestionSchema = z5.object({
  id: z5.string().trim().min(1).max(160),
  prompt: z5.string().trim().min(1).max(4e3),
  helpText: z5.string().trim().max(4e3).nullable().optional(),
  selectionMode: z5.enum(["single", "multi"]),
  required: z5.boolean().optional(),
  allowOther: z5.boolean().optional(),
  options: z5.array(askUserQuestionsQuestionOptionSchema).min(1).max(129)
});
var paperclipQuestionOptionSchema = z5.object({
  id: z5.string().min(1).max(160),
  label: z5.string().min(1).max(1e3),
  description: z5.string().max(4e3).optional(),
  recommended: z5.boolean().optional()
});
var paperclipQuestionSchema = z5.object({
  id: z5.string().min(1).max(160),
  header: z5.string().max(1e3).optional(),
  prompt: z5.string().min(1).max(4e3),
  helpText: z5.string().max(4e3).optional(),
  required: z5.boolean(),
  answerMode: z5.enum(["single_select", "multi_select", "text"]),
  initialText: z5.string().refine((value) => value.length <= 2e5 && Array.from(value).length <= 1e5, "initial text exceeds 100000 Unicode code points").optional(),
  options: z5.array(paperclipQuestionOptionSchema).max(128).optional(),
  customAnswer: z5.object({
    enabled: z5.literal(true),
    label: z5.string().max(1e3).optional(),
    placeholder: z5.string().max(1e3).optional()
  }).optional(),
  textValidation: z5.object({
    minLength: z5.number().int().min(0).max(1e5).optional(),
    maxLength: z5.number().int().min(0).max(1e5).optional(),
    pattern: z5.string().max(1e3).optional(),
    inputType: z5.enum(["text", "number", "integer"]).optional(),
    minimum: z5.number().finite().optional(),
    maximum: z5.number().finite().optional()
  }).optional()
}).superRefine((value, ctx) => {
  if (value.initialText !== void 0 && value.answerMode !== "text") {
    ctx.addIssue({ code: z5.ZodIssueCode.custom, message: "only text questions can define initial text", path: ["initialText"] });
  }
  if (value.answerMode === "text" && value.options && value.options.length > 0) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "text questions cannot define options",
      path: ["options"]
    });
  }
  if (value.answerMode !== "text" && (!value.options || value.options.length === 0)) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "select questions require options",
      path: ["options"]
    });
  }
  if (value.answerMode === "text" && value.customAnswer) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "text questions cannot define customAnswer",
      path: ["customAnswer"]
    });
  }
  if (value.textValidation?.minLength !== void 0 && value.textValidation.maxLength !== void 0 && value.textValidation.minLength > value.textValidation.maxLength) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "minLength cannot exceed maxLength",
      path: ["textValidation"]
    });
  }
  if (value.textValidation?.minimum !== void 0 && value.textValidation.maximum !== void 0 && value.textValidation.minimum > value.textValidation.maximum) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "minimum cannot exceed maximum",
      path: ["textValidation"]
    });
  }
  if (value.textValidation?.pattern !== void 0) {
    try {
      new RegExp(value.textValidation.pattern);
    } catch {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "pattern must be a valid regular expression",
        path: ["textValidation", "pattern"]
      });
    }
  }
  const optionIds = value.options?.map((option) => option.id) ?? [];
  if (new Set(optionIds).size !== optionIds.length) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "option ids must be unique",
      path: ["options"]
    });
  }
});
var paperclipQuestionSetPayloadSchema = z5.object({
  schema: z5.literal("paperclip.question_set.v1"),
  title: z5.string().max(1e3).optional(),
  description: z5.string().max(1e5).optional(),
  submitLabel: z5.string().max(200).optional(),
  questions: z5.array(paperclipQuestionSchema).min(1).max(64)
}).superRefine((value, ctx) => {
  const questionIds = value.questions.map((question) => question.id);
  if (new Set(questionIds).size !== questionIds.length) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "question ids must be unique",
      path: ["questions"]
    });
  }
});
var askUserQuestionsPayloadFields = {
  version: z5.literal(1),
  title: z5.string().trim().max(240).nullable().optional(),
  submitLabel: z5.string().trim().max(120).nullable().optional(),
  supersedeOnUserComment: z5.boolean().optional(),
  questions: z5.array(askUserQuestionsQuestionSchema).min(1).max(64),
  /** Exact canonical presentation retained for a recovered harness request. */
  questionSet: paperclipQuestionSetPayloadSchema.optional(),
  /** Stable correlation for draft handoff from a live runtime request. */
  runtimeRequestId: z5.string().trim().min(1).max(255).nullable().optional()
};
var askUserQuestionsPayloadSchema = z5.object(askUserQuestionsPayloadFields).superRefine((value, ctx) => {
  const seenQuestionIds = /* @__PURE__ */ new Set();
  for (const [questionIndex, question] of value.questions.entries()) {
    if (seenQuestionIds.has(question.id)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "Question ids must be unique within one interaction",
        path: ["questions", questionIndex, "id"]
      });
    }
    seenQuestionIds.add(question.id);
    const seenOptionIds = /* @__PURE__ */ new Set();
    let freeTextOptionCount = 0;
    for (const [optionIndex, option] of question.options.entries()) {
      if (seenOptionIds.has(option.id)) {
        ctx.addIssue({
          code: z5.ZodIssueCode.custom,
          message: "Option ids must be unique within one question",
          path: ["questions", questionIndex, "options", optionIndex, "id"]
        });
      }
      seenOptionIds.add(option.id);
      if (option.freeText) {
        freeTextOptionCount += 1;
        if (freeTextOptionCount > 1) {
          ctx.addIssue({
            code: z5.ZodIssueCode.custom,
            message: "A question may declare at most one free-text option",
            path: [
              "questions",
              questionIndex,
              "options",
              optionIndex,
              "freeText"
            ]
          });
        }
      }
    }
  }
});
var askUserQuestionsAnswerSchema = z5.object({
  questionId: z5.string().trim().min(1).max(160),
  optionIds: z5.array(z5.string().trim().min(1).max(160)).max(129),
  // The persisted question determines whether this is exact editor text or a
  // legacy custom answer; normalize only after that trusted context is known.
  otherText: z5.string().max(1e5).nullable().optional()
});
var askUserQuestionsResultSchema = z5.object({
  version: z5.literal(1),
  outcome: z5.enum(["skipped", "withdrawn", "issue_closed", "addressee_deleted"]).optional(),
  reason: z5.string().trim().max(4e3).nullable().optional(),
  answers: z5.array(askUserQuestionsAnswerSchema).max(64),
  cancelled: z5.literal(true).optional(),
  cancellationReason: z5.string().trim().max(4e3).nullable().optional(),
  expirationReason: z5.enum(["superseded_by_comment", "superseded_by_newer_interaction"]).optional(),
  commentId: z5.string().guid().nullable().optional(),
  // Set alongside expirationReason "superseded_by_newer_interaction": the id of
  // the newer sibling ask_user_questions that replaced this one (PAP-437).
  supersededByInteractionId: z5.string().guid().nullable().optional(),
  summaryMarkdown: z5.string().max(2e4).nullable().optional()
});
var requestConfirmationHrefSchema = z5.string().trim().min(1).max(2e3).refine((value) => {
  if (value.startsWith("#")) return true;
  if (value.startsWith("/")) return !value.startsWith("//");
  return /^https?:\/\//i.test(value);
}, "href must be a root-relative path, same-page fragment, or http(s) URL");
var requestConfirmationTargetBaseSchema = z5.object({
  label: z5.string().trim().min(1).max(120).nullable().optional(),
  href: requestConfirmationHrefSchema.nullable().optional()
});
var requestConfirmationIssueDocumentTargetSchema = requestConfirmationTargetBaseSchema.extend({
  type: z5.literal("issue_document"),
  issueId: z5.string().guid().nullable().optional(),
  documentId: z5.string().guid().nullable().optional(),
  key: issueDocumentKeySchema,
  revisionId: z5.string().guid(),
  revisionNumber: z5.number().int().positive().nullable().optional()
});
var requestConfirmationCustomTargetSchema = requestConfirmationTargetBaseSchema.extend({
  type: z5.literal("custom"),
  key: z5.string().trim().min(1).max(120),
  revisionId: z5.string().trim().min(1).max(255).nullable().optional(),
  revisionNumber: z5.number().int().positive().nullable().optional()
});
var requestConfirmationIssueAttachmentTargetSchema = requestConfirmationTargetBaseSchema.extend({
  type: z5.literal("issue_attachment"),
  issueId: z5.string().guid().nullable().optional(),
  attachmentId: z5.string().guid(),
  assetId: z5.string().guid(),
  sha256: z5.string().regex(/^[a-f0-9]{64}$/, "sha256 must identify the exact attachment bytes")
});
var requestConfirmationTargetSchema = z5.discriminatedUnion("type", [
  requestConfirmationIssueDocumentTargetSchema,
  requestConfirmationIssueAttachmentTargetSchema,
  requestConfirmationCustomTargetSchema
]);
var requestConfirmationToolActionPayloadSchema = z5.object({
  version: z5.literal(1),
  actionRequestId: z5.string().guid(),
  invocationId: z5.string().guid(),
  toolName: z5.string().trim().min(1).max(500),
  toolDisplayName: z5.string().trim().min(1).max(500),
  connectionId: z5.string().guid().nullable(),
  applicationId: z5.string().guid().nullable(),
  appDisplayName: z5.string().trim().min(1).max(500).nullable(),
  risk: z5.enum(["read", "write", "destructive"]),
  rememberActionScope: z5.string().trim().min(1).max(1e3).optional(),
  previewMarkdown: z5.string().trim().min(1).max(2e4),
  argumentsSummaryJson: z5.string().max(2e4),
  argumentsHash: z5.string().trim().min(1).max(255),
  expiresAt: z5.string().datetime({ offset: true })
});
var requestConfirmationSecretProposalPayloadSchema = z5.object({
  version: z5.literal(1),
  proposalId: z5.string().guid(),
  sourceSecretLabel: z5.string().trim().min(1).max(500),
  configPath: z5.string().trim().min(1).max(500),
  targetAgentId: z5.string().guid(),
  targetAgentName: z5.string().trim().min(1).max(500),
  justification: z5.string().trim().min(1).max(2e4),
  expiresAt: z5.string().datetime({ offset: true })
});
var qualityReviewBindingSchema = z5.object({
  key: z5.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
  requirementHash: z5.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict();
var requestConfirmationPayloadSchema = z5.object({
  qualityReview: qualityReviewBindingSchema.optional(),
  version: z5.literal(1),
  prompt: z5.string().trim().min(1).max(1e3),
  acceptLabel: z5.string().trim().min(1).max(80).nullable().optional(),
  rejectLabel: z5.string().trim().min(1).max(80).nullable().optional(),
  rejectRequiresReason: z5.boolean().optional(),
  rejectReasonLabel: z5.string().trim().min(1).max(160).nullable().optional(),
  allowDeclineReason: z5.boolean().optional().default(true),
  declineReasonPlaceholder: z5.string().trim().min(1).max(240).nullable().optional(),
  detailsMarkdown: z5.string().max(2e4).nullable().optional(),
  supersedeOnUserComment: z5.boolean().optional(),
  target: requestConfirmationTargetSchema.nullable().optional(),
  toolAction: requestConfirmationToolActionPayloadSchema.optional(),
  secretProposal: requestConfirmationSecretProposalPayloadSchema.optional()
});
var requestCheckboxConfirmationOptionSchema = z5.object({
  id: z5.string().trim().min(1).max(120),
  label: z5.string().trim().min(1).max(120),
  description: z5.string().trim().max(500).nullable().optional()
});
var requestCheckboxConfirmationPayloadSchema = z5.object({
  version: z5.literal(1),
  prompt: z5.string().trim().min(1).max(1e3),
  detailsMarkdown: z5.string().max(2e4).nullable().optional(),
  options: z5.array(requestCheckboxConfirmationOptionSchema).min(1).max(REQUEST_CHECKBOX_CONFIRMATION_OPTION_LIMIT),
  defaultSelectedOptionIds: z5.array(z5.string().trim().min(1).max(120)).max(REQUEST_CHECKBOX_CONFIRMATION_OPTION_LIMIT).optional().default([]),
  minSelected: z5.number().int().min(0).optional().default(0),
  maxSelected: z5.number().int().min(0).nullable().optional(),
  acceptLabel: z5.string().trim().min(1).max(80).nullable().optional(),
  rejectLabel: z5.string().trim().min(1).max(80).nullable().optional(),
  rejectRequiresReason: z5.boolean().optional(),
  rejectReasonLabel: z5.string().trim().min(1).max(160).nullable().optional(),
  allowDeclineReason: z5.boolean().optional().default(true),
  declineReasonPlaceholder: z5.string().trim().min(1).max(240).nullable().optional(),
  supersedeOnUserComment: z5.boolean().optional(),
  target: requestConfirmationTargetSchema.nullable().optional()
}).superRefine((value, ctx) => {
  const optionIds = /* @__PURE__ */ new Set();
  for (const [index, option] of value.options.entries()) {
    if (optionIds.has(option.id)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "Option ids must be unique within one checkbox confirmation",
        path: ["options", index, "id"]
      });
    }
    optionIds.add(option.id);
  }
  const defaultSelectedOptionIds = /* @__PURE__ */ new Set();
  for (const [index, optionId] of value.defaultSelectedOptionIds.entries()) {
    if (defaultSelectedOptionIds.has(optionId)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "defaultSelectedOptionIds must be unique",
        path: ["defaultSelectedOptionIds", index]
      });
      continue;
    }
    defaultSelectedOptionIds.add(optionId);
    if (!optionIds.has(optionId)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "defaultSelectedOptionIds must reference existing option ids",
        path: ["defaultSelectedOptionIds", index]
      });
    }
  }
  const maxSelected = value.maxSelected ?? null;
  if (value.minSelected > value.options.length) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "minSelected cannot exceed the option count",
      path: ["minSelected"]
    });
  }
  if (value.defaultSelectedOptionIds.length < value.minSelected) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "defaultSelectedOptionIds must satisfy minSelected",
      path: ["defaultSelectedOptionIds"]
    });
  }
  if (maxSelected != null) {
    if (maxSelected < value.minSelected) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "maxSelected must be greater than or equal to minSelected",
        path: ["maxSelected"]
      });
    }
    if (maxSelected > value.options.length) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "maxSelected cannot exceed the option count",
        path: ["maxSelected"]
      });
    }
    if (value.defaultSelectedOptionIds.length > maxSelected) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "defaultSelectedOptionIds cannot exceed maxSelected",
        path: ["defaultSelectedOptionIds"]
      });
    }
  }
});
var requestConfirmationResumeFailureSchema = z5.object({
  status: z5.enum(["retrying", "needs_attention"]),
  errorCode: z5.string().trim().min(1).max(120).nullable(),
  attempt: z5.number().int().min(0).max(100),
  maxAttempts: z5.number().int().min(0).max(100),
  runId: z5.string().guid().nullable().optional(),
  retryRunId: z5.string().guid().nullable().optional(),
  recoveryActionId: z5.string().guid().nullable().optional(),
  updatedAt: z5.string().trim().min(1).nullable().optional()
});
var requestConfirmationToolActionResultSchema = z5.object({
  version: z5.literal(1),
  rememberedAction: z5.boolean().optional(),
  status: z5.enum(["approved", "executing", "executed", "failed", "expired"]),
  errorCode: z5.string().trim().min(1).max(120).nullable().optional(),
  errorMessage: z5.string().trim().min(1).max(4e3).nullable().optional(),
  // Populated on `executed` so the card can report the outcome (e.g. "Row 42
  // added") instead of a bare checkmark, with an optional deep-link when the
  // connector returns a URL (PAP-13745 §5 Executed / Peak-End).
  resultSummary: z5.string().trim().min(1).max(4e3).nullable().optional(),
  resultHref: z5.string().trim().url().max(2e3).nullable().optional(),
  updatedAt: z5.string().datetime({ offset: true })
});
var requestConfirmationSecretProposalResultSchema = z5.object({
  version: z5.literal(1),
  status: z5.enum(["executed", "failed", "rejected", "withdrawn", "expired"]),
  errorCode: z5.string().trim().min(1).max(120).nullable().optional(),
  updatedAt: z5.string().datetime({ offset: true })
});
var requestConfirmationResultSchema = z5.object({
  version: z5.literal(1),
  outcome: z5.enum([
    "accepted",
    "rejected",
    "superseded_by_comment",
    "superseded_by_newer_request",
    "stale_target",
    "skipped",
    "withdrawn",
    "issue_closed",
    "addressee_deleted"
  ]),
  reason: z5.string().trim().max(4e3).nullable().optional(),
  commentId: z5.string().guid().nullable().optional(),
  supersededByInteractionId: z5.string().guid().nullable().optional(),
  staleTarget: requestConfirmationTargetSchema.nullable().optional(),
  resumeFailure: requestConfirmationResumeFailureSchema.nullable().optional(),
  toolAction: requestConfirmationToolActionResultSchema.optional(),
  secretProposal: requestConfirmationSecretProposalResultSchema.optional()
});
var requestCheckboxConfirmationResultSchema = requestConfirmationResultSchema.extend({
  selectedOptionIds: z5.array(z5.string().trim().min(1).max(120)).max(REQUEST_CHECKBOX_CONFIRMATION_OPTION_LIMIT).optional()
}).superRefine((value, ctx) => {
  const selectedOptionIds = value.selectedOptionIds ?? [];
  const seenOptionIds = /* @__PURE__ */ new Set();
  for (const [index, optionId] of selectedOptionIds.entries()) {
    if (seenOptionIds.has(optionId)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "selectedOptionIds must be unique",
        path: ["selectedOptionIds", index]
      });
    }
    seenOptionIds.add(optionId);
  }
});
var requestItemVerdictValueSchema = z5.enum([
  "approve",
  "reject",
  "defer"
]);
var requestItemVerdictsItemSchema = z5.object({
  qualityReview: qualityReviewBindingSchema.optional(),
  target: requestConfirmationTargetSchema.nullable().optional(),
  id: z5.string().trim().min(1).max(120),
  label: z5.string().trim().min(1).max(120),
  description: z5.string().trim().max(500).nullable().optional(),
  previewMarkdown: z5.string().max(2e4).nullable().optional(),
  href: requestConfirmationHrefSchema.nullable().optional(),
  attachmentId: z5.string().guid().nullable().optional()
});
var requestItemVerdictsPayloadSchema = z5.object({
  version: z5.literal(1),
  prompt: z5.string().trim().min(1).max(1e3),
  detailsMarkdown: z5.string().max(2e4).nullable().optional(),
  items: z5.array(requestItemVerdictsItemSchema).min(1).max(REQUEST_ITEM_VERDICTS_ITEM_LIMIT),
  verdicts: z5.array(requestItemVerdictValueSchema).min(2).max(3).optional().default(["approve", "reject"]),
  requireReasonOn: z5.array(requestItemVerdictValueSchema).max(3).optional().default(["reject"]),
  reasonLabel: z5.string().trim().min(1).max(160).nullable().optional(),
  allowBulkApprove: z5.boolean().optional().default(true),
  supersedeOnUserComment: z5.boolean().optional(),
  target: requestConfirmationTargetSchema.nullable().optional()
}).superRefine((value, ctx) => {
  const itemIds = /* @__PURE__ */ new Set();
  const qualityKeys = /* @__PURE__ */ new Set();
  for (const [index, item] of value.items.entries()) {
    if (item.qualityReview) {
      if (qualityKeys.has(item.qualityReview.key)) ctx.addIssue({ code: z5.ZodIssueCode.custom, message: "Quality review keys must be unique within one request", path: ["items", index, "qualityReview", "key"] });
      qualityKeys.add(item.qualityReview.key);
    }
    if (itemIds.has(item.id)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "Item ids must be unique within one item verdict request",
        path: ["items", index, "id"]
      });
    }
    itemIds.add(item.id);
  }
  const verdicts = /* @__PURE__ */ new Set();
  for (const [index, verdict] of value.verdicts.entries()) {
    if (verdicts.has(verdict)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "verdicts must be unique",
        path: ["verdicts", index]
      });
    }
    verdicts.add(verdict);
  }
  if (!verdicts.has("approve") || !verdicts.has("reject")) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "verdicts must include approve and reject; defer is optional",
      path: ["verdicts"]
    });
  }
  const reasonVerdicts = /* @__PURE__ */ new Set();
  for (const [index, verdict] of value.requireReasonOn.entries()) {
    if (reasonVerdicts.has(verdict)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "requireReasonOn must be unique",
        path: ["requireReasonOn", index]
      });
      continue;
    }
    reasonVerdicts.add(verdict);
    if (!verdicts.has(verdict)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "requireReasonOn must reference enabled verdicts",
        path: ["requireReasonOn", index]
      });
    }
  }
});
var requestItemVerdictsResultItemSchema = z5.object({
  id: z5.string().trim().min(1).max(120),
  verdict: requestItemVerdictValueSchema,
  reason: z5.string().trim().max(4e3).nullable().optional(),
  resolvedByUserId: z5.string().trim().min(1).max(255).nullable().optional(),
  resolvedByAgentId: z5.string().guid().nullable().optional(),
  resolvedByRunId: z5.string().guid().nullable().optional(),
  resolvedAt: z5.union([z5.string().datetime(), z5.date()]),
  commentId: z5.string().guid().nullable().optional()
}).superRefine((value, ctx) => {
  if (!value.resolvedByUserId && !value.resolvedByAgentId) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "a user or agent resolver is required",
      path: ["resolvedByUserId"]
    });
  }
  if (value.resolvedByAgentId && !value.resolvedByRunId) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      message: "resolvedByRunId is required for an agent resolver",
      path: ["resolvedByRunId"]
    });
  }
});
var requestItemVerdictsResultSchema = z5.object({
  version: z5.literal(1),
  outcome: z5.enum([
    "resolved",
    "superseded_by_comment",
    "stale_target",
    "cancelled",
    "skipped",
    "withdrawn",
    "issue_closed",
    "addressee_deleted"
  ]),
  reason: z5.string().trim().max(4e3).nullable().optional(),
  complete: z5.boolean(),
  items: z5.array(requestItemVerdictsResultItemSchema).max(REQUEST_ITEM_VERDICTS_ITEM_LIMIT),
  commentId: z5.string().guid().nullable().optional(),
  staleTarget: requestConfirmationTargetSchema.nullable().optional()
}).superRefine((value, ctx) => {
  const itemIds = /* @__PURE__ */ new Set();
  for (const [index, item] of value.items.entries()) {
    if (itemIds.has(item.id)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "result item ids must be unique",
        path: ["items", index, "id"]
      });
    }
    itemIds.add(item.id);
  }
});
var createIssueThreadInteractionCommon = {
  resolverPolicy: issueThreadInteractionResolverPolicySchema.optional(),
  addresseeAgentId: z5.string().guid().nullable().optional(),
  addresseeUserId: z5.string().trim().min(1).nullable().optional()
};
var createLegacyAskUserQuestionsPayloadSchema = askUserQuestionsPayloadSchema.superRefine((value, ctx) => {
  if (!value.questionSet) return;
  const shown = new Set(value.questionSet.questions.map((question) => question.id));
  const stored = new Set(value.questions.map((question) => question.id));
  if (shown.size !== stored.size || [...shown].some((id) => !stored.has(id))) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      path: ["questionSet", "questions"],
      message: "questionSet must present every questions entry with the same question IDs. Include choice questions as well as text questions; a partial form hides required answers."
    });
  }
  const storedById = new Map(value.questions.map((question) => [question.id, question]));
  for (const [index, question] of value.questionSet.questions.entries()) {
    const storage = storedById.get(question.id);
    if (!storage) continue;
    const mismatch = (field) => ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      path: ["questionSet", "questions", index, field],
      message: `questionSet ${field} must match the corresponding questions entry.`
    });
    if (question.prompt.trim() !== storage.prompt) mismatch("prompt");
    if (storage.required !== void 0 && question.required !== storage.required) mismatch("required");
    const mode = question.answerMode === "multi_select" ? "multi" : "single";
    if (storage.selectionMode !== mode) mismatch("answerMode");
    if (question.answerMode === "text") {
      if (storage.options.length !== 1 || !storage.options[0].freeText) mismatch("answerMode");
    } else {
      const choices = storage.options.filter((option) => !option.freeText);
      const canonical = new Map((question.options ?? []).map((option) => [option.id, option.label.trim()]));
      if (choices.length !== canonical.size || choices.some((option) => canonical.get(option.id) !== option.label)) mismatch("options");
      const allowsCustomAnswer = storage.allowOther === true || storage.options.some((option) => option.freeText);
      if (Boolean(question.customAnswer?.enabled) !== allowsCustomAnswer) mismatch("customAnswer");
    }
  }
});
var createAskUserQuestionsPayloadSchema = z5.union([
  createLegacyAskUserQuestionsPayloadSchema,
  z5.object({
    ...askUserQuestionsPayloadFields,
    // Do not discard an explicitly supplied conflicting compatibility form.
    questions: z5.never().optional(),
    questionSet: paperclipQuestionSetPayloadSchema
  }).transform(({ questions: _questions, ...value }) => ({
    ...questionSetToAskUserQuestionsPayload(value.questionSet),
    ...value
  })).pipe(createLegacyAskUserQuestionsPayloadSchema)
]);
var createIssueThreadInteractionSchema = z5.discriminatedUnion("kind", [
  z5.object({
    ...createIssueThreadInteractionCommon,
    kind: z5.literal("suggest_tasks"),
    idempotencyKey: z5.string().trim().max(255).nullable().optional(),
    sourceCommentId: z5.string().guid().nullable().optional(),
    sourceRunId: z5.string().guid().nullable().optional(),
    title: z5.string().trim().max(240).nullable().optional(),
    summary: z5.string().trim().max(1e3).nullable().optional(),
    continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
    payload: suggestTasksPayloadSchema
  }),
  z5.object({
    ...createIssueThreadInteractionCommon,
    kind: z5.literal("ask_user_questions"),
    idempotencyKey: z5.string().trim().max(255).nullable().optional(),
    sourceCommentId: z5.string().guid().nullable().optional(),
    sourceRunId: z5.string().guid().nullable().optional(),
    title: z5.string().trim().max(240).nullable().optional(),
    summary: z5.string().trim().max(1e3).nullable().optional(),
    continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
    payload: createAskUserQuestionsPayloadSchema
  }),
  z5.object({
    ...createIssueThreadInteractionCommon,
    kind: z5.literal("request_confirmation"),
    idempotencyKey: z5.string().trim().max(255).nullable().optional(),
    sourceCommentId: z5.string().guid().nullable().optional(),
    sourceRunId: z5.string().guid().nullable().optional(),
    title: z5.string().trim().max(240).nullable().optional(),
    summary: z5.string().trim().max(1e3).nullable().optional(),
    continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("none"),
    payload: requestConfirmationPayloadSchema
  }),
  z5.object({
    ...createIssueThreadInteractionCommon,
    kind: z5.literal("request_checkbox_confirmation"),
    idempotencyKey: z5.string().trim().max(255).nullable().optional(),
    sourceCommentId: z5.string().guid().nullable().optional(),
    sourceRunId: z5.string().guid().nullable().optional(),
    title: z5.string().trim().max(240).nullable().optional(),
    summary: z5.string().trim().max(1e3).nullable().optional(),
    continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
    payload: requestCheckboxConfirmationPayloadSchema
  }),
  z5.object({
    ...createIssueThreadInteractionCommon,
    kind: z5.literal("request_item_verdicts"),
    idempotencyKey: z5.string().trim().max(255).nullable().optional(),
    sourceCommentId: z5.string().guid().nullable().optional(),
    sourceRunId: z5.string().guid().nullable().optional(),
    title: z5.string().trim().max(240).nullable().optional(),
    summary: z5.string().trim().max(1e3).nullable().optional(),
    continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
    payload: requestItemVerdictsPayloadSchema
  })
]);
var acceptIssueThreadInteractionSchema = z5.object({
  rememberAction: z5.boolean().optional(),
  selectedClientKeys: z5.array(z5.string().trim().min(1).max(120)).min(1).max(50).optional(),
  selectedOptionIds: z5.array(z5.string().trim().min(1).max(120)).max(REQUEST_CHECKBOX_CONFIRMATION_OPTION_LIMIT).optional()
}).superRefine((value, ctx) => {
  const seenClientKeys = /* @__PURE__ */ new Set();
  for (const [index, clientKey] of (value.selectedClientKeys ?? []).entries()) {
    if (seenClientKeys.has(clientKey)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "selectedClientKeys must be unique",
        path: ["selectedClientKeys", index]
      });
      continue;
    }
    seenClientKeys.add(clientKey);
  }
  const seenOptionIds = /* @__PURE__ */ new Set();
  for (const [index, optionId] of (value.selectedOptionIds ?? []).entries()) {
    if (seenOptionIds.has(optionId)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "selectedOptionIds must be unique",
        path: ["selectedOptionIds", index]
      });
      continue;
    }
    seenOptionIds.add(optionId);
  }
});
var resolveConfirmationFromCommentSchema = z5.object({
  commentId: z5.string().guid(),
  decision: z5.enum(["accept", "reject"]),
  selectedOptionIds: z5.array(z5.string().trim().min(1).max(120)).max(REQUEST_CHECKBOX_CONFIRMATION_OPTION_LIMIT).optional(),
  reason: z5.string().trim().max(4e3).optional()
}).strict().superRefine((value, ctx) => {
  if (value.decision === "reject" && value.selectedOptionIds !== void 0) {
    ctx.addIssue({ code: z5.ZodIssueCode.custom, path: ["selectedOptionIds"], message: "Selections apply only to acceptance" });
  }
  if (value.selectedOptionIds && new Set(value.selectedOptionIds).size !== value.selectedOptionIds.length) {
    ctx.addIssue({ code: z5.ZodIssueCode.custom, path: ["selectedOptionIds"], message: "Selections must be unique" });
  }
});
var rejectIssueThreadInteractionSchema = z5.object({
  reason: z5.string().trim().max(4e3).optional()
});
var cancelIssueThreadInteractionSchema = z5.object({
  reason: z5.string().trim().max(4e3).optional()
});
var skipIssueThreadInteractionSchema = z5.object({
  reason: z5.string().trim().max(4e3).optional()
});
var withdrawIssueThreadInteractionSchema = z5.object({
  reason: z5.string().trim().max(4e3).optional()
});
var respondIssueThreadInteractionSchema = z5.object({
  answers: z5.array(askUserQuestionsAnswerSchema).max(20),
  summaryMarkdown: multilineTextSchema.pipe(z5.string().max(2e4)).nullable().optional()
});
var submitIssueThreadInteractionVerdictsSchema = z5.object({
  verdicts: z5.array(
    z5.object({
      id: z5.string().trim().min(1).max(120),
      verdict: requestItemVerdictValueSchema,
      reason: z5.string().trim().max(4e3).nullable().optional()
    })
  ).min(1).max(REQUEST_ITEM_VERDICTS_ITEM_LIMIT)
}).superRefine((value, ctx) => {
  const itemIds = /* @__PURE__ */ new Set();
  for (const [index, verdict] of value.verdicts.entries()) {
    if (itemIds.has(verdict.id)) {
      ctx.addIssue({
        code: z5.ZodIssueCode.custom,
        message: "verdict item ids must be unique",
        path: ["verdicts", index, "id"]
      });
    }
    itemIds.add(verdict.id);
  }
});
var linkIssueApprovalSchema = z5.object({
  approvalId: z5.string().guid()
});
var createIssueAttachmentMetadataSchema = z5.object({
  issueCommentId: z5.string().guid().optional().nullable()
});
var ISSUE_DOCUMENT_FORMATS = ["markdown"];
var issueDocumentFormatSchema = z5.enum(ISSUE_DOCUMENT_FORMATS);
var upsertIssueDocumentSchema = z5.object({
  title: z5.string().trim().max(200).nullable().optional(),
  format: issueDocumentFormatSchema,
  body: multilineTextSchema.pipe(z5.string().max(524288)),
  changeSummary: z5.string().trim().max(500).nullable().optional(),
  baseRevisionId: z5.string().guid().nullable().optional()
});
var restoreIssueDocumentRevisionSchema = z5.object({});

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/secret.ts
import { z as z6 } from "zod";
var secretKeySchema = z6.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/);
var secretVersionSelectorSchema = z6.union([z6.literal("latest"), z6.number().int().positive()]);
var creatableSecretStatusSchema = z6.enum(["active", "disabled", "archived"]);
var envBindingPlainSchema = z6.object({
  type: z6.literal("plain"),
  value: z6.string()
});
var envBindingSecretRefSchema = z6.object({
  type: z6.literal("secret_ref"),
  secretId: z6.string().guid(),
  version: secretVersionSelectorSchema.optional(),
  projectionClass: z6.enum(SECRET_PROJECTION_CLASSES).optional(),
  projectionAllowlistKey: z6.string().trim().min(1).max(160).optional().nullable()
});
var envBindingUserSecretRefSchema = z6.object({
  type: z6.literal("user_secret_ref"),
  key: secretKeySchema,
  version: secretVersionSelectorSchema.optional(),
  required: z6.boolean().optional().default(true),
  allowMissingOverride: z6.boolean().optional().default(false)
});
var envBindingSchema = z6.union([
  z6.string(),
  envBindingPlainSchema,
  envBindingSecretRefSchema,
  envBindingUserSecretRefSchema
]);
var envConfigSchema = z6.record(z6.string(), envBindingSchema);
var createSecretSchema = z6.object({
  name: z6.string().min(1),
  key: secretKeySchema.optional(),
  provider: z6.enum(SECRET_PROVIDERS).optional(),
  providerConfigId: z6.string().guid().optional().nullable(),
  managedMode: z6.enum(SECRET_MANAGED_MODES).optional(),
  value: z6.string().min(1).optional().nullable(),
  description: z6.string().optional().nullable(),
  externalRef: z6.string().optional().nullable(),
  providerMetadata: z6.record(z6.string(), z6.unknown()).optional().nullable(),
  providerVersionRef: z6.string().optional().nullable()
}).superRefine((value, ctx) => {
  if ((value.managedMode ?? "paperclip_managed") === "external_reference") {
    if (!value.externalRef?.trim()) {
      ctx.addIssue({
        code: z6.ZodIssueCode.custom,
        path: ["externalRef"],
        message: "External reference secrets require externalRef"
      });
    }
    return;
  }
  if (value.externalRef?.trim()) {
    ctx.addIssue({
      code: z6.ZodIssueCode.custom,
      path: ["externalRef"],
      message: "Managed secrets cannot set externalRef"
    });
  }
  if (!value.value?.trim()) {
    ctx.addIssue({
      code: z6.ZodIssueCode.custom,
      path: ["value"],
      message: "Managed secrets require value"
    });
  }
});
function requireSecretRotationInput(value, ctx) {
  if (!value.value?.trim() && !value.externalRef?.trim() && value.providerVersionRef == null && value.providerConfigId == null) {
    ctx.addIssue({
      code: z6.ZodIssueCode.custom,
      path: ["value"],
      message: "Secret rotation requires value, externalRef, providerVersionRef, or providerConfigId"
    });
  }
}
var rotateSecretSchema = z6.object({
  value: z6.string().min(1).optional().nullable(),
  externalRef: z6.string().optional().nullable(),
  providerVersionRef: z6.string().optional().nullable(),
  providerConfigId: z6.string().guid().optional().nullable()
}).superRefine(requireSecretRotationInput);
var updateSecretSchema = z6.object({
  name: z6.string().min(1).optional(),
  key: secretKeySchema.optional(),
  status: z6.enum(SECRET_STATUSES).optional(),
  providerConfigId: z6.string().guid().optional().nullable(),
  description: z6.string().optional().nullable(),
  externalRef: z6.string().optional().nullable(),
  providerMetadata: z6.record(z6.string(), z6.unknown()).optional().nullable()
});
var secretBindingTargetSchema = z6.object({
  targetType: z6.enum(SECRET_BINDING_TARGET_TYPES),
  targetId: z6.string().min(1),
  configPath: z6.string().min(1)
});
var createSecretBindingSchema = secretBindingTargetSchema.extend({
  secretId: z6.string().guid(),
  versionSelector: secretVersionSelectorSchema.default("latest"),
  required: z6.boolean().default(true),
  label: z6.string().optional().nullable(),
  projectionClass: z6.enum(SECRET_PROJECTION_CLASSES).optional(),
  projectionAllowlistKey: z6.string().trim().min(1).max(160).optional().nullable()
});
var createUserSecretDefinitionSchema = z6.object({
  key: secretKeySchema,
  name: z6.string().trim().min(1).max(160),
  description: z6.string().trim().max(500).optional().nullable(),
  status: creatableSecretStatusSchema.optional(),
  provider: z6.enum(SECRET_PROVIDERS).optional(),
  providerConfigId: z6.string().guid().optional().nullable(),
  managedMode: z6.enum(SECRET_MANAGED_MODES).optional(),
  providerMetadata: z6.record(z6.string(), z6.unknown()).optional().nullable(),
  usageGuidance: z6.string().trim().max(1e3).optional().nullable()
});
var updateUserSecretDefinitionSchema = z6.object({
  name: z6.string().trim().min(1).max(160).optional(),
  description: z6.string().trim().max(500).optional().nullable(),
  status: z6.enum(SECRET_STATUSES).optional(),
  providerConfigId: z6.string().guid().optional().nullable(),
  providerMetadata: z6.record(z6.string(), z6.unknown()).optional().nullable(),
  usageGuidance: z6.string().trim().max(1e3).optional().nullable()
});
var createUserSecretValueSchema = z6.object({
  definitionKey: secretKeySchema.optional(),
  definitionId: z6.string().guid().optional(),
  value: z6.string().min(1).optional().nullable(),
  externalRef: z6.string().optional().nullable(),
  providerVersionRef: z6.string().optional().nullable(),
  providerConfigId: z6.string().guid().optional().nullable()
}).superRefine((value, ctx) => {
  if (!value.definitionKey && !value.definitionId) {
    ctx.addIssue({
      code: z6.ZodIssueCode.custom,
      path: ["definitionId"],
      message: "User secret value requires definitionId or definitionKey"
    });
  }
  if (!value.value?.trim() && !value.externalRef?.trim()) {
    ctx.addIssue({
      code: z6.ZodIssueCode.custom,
      path: ["value"],
      message: "User secret value requires value or externalRef"
    });
  }
});
var updateUserSecretValueSchema = z6.object({
  status: z6.enum(SECRET_STATUSES).optional(),
  value: z6.string().min(1).optional().nullable(),
  externalRef: z6.string().min(1).optional().nullable(),
  providerVersionRef: z6.string().min(1).optional().nullable(),
  providerConfigId: z6.string().guid().optional().nullable()
});
var rotateUserSecretValueSchema = z6.object({
  value: z6.string().min(1).optional().nullable(),
  externalRef: z6.string().min(1).optional().nullable(),
  providerVersionRef: z6.string().min(1).optional().nullable(),
  providerConfigId: z6.string().guid().optional().nullable()
}).superRefine(requireSecretRotationInput);
var createUserSecretDeclarationSchema = secretBindingTargetSchema.extend({
  definitionKey: secretKeySchema,
  envKey: z6.string().trim().min(1),
  versionSelector: secretVersionSelectorSchema.default("latest"),
  required: z6.boolean().default(true),
  allowMissingOverride: z6.boolean().default(false),
  label: z6.string().optional().nullable()
});
var safeShortText = z6.string().trim().min(1).max(160);
var optionalSafeShortText = safeShortText.optional().nullable();
var deniedProviderConfigKeyPattern = /^(access[-_]?key([-_]?id)?|secret[-_]?access[-_]?key|secret[-_]?key|token|password|passwd|credential|credentials|private[-_]?key|pem|jwt|session[-_]?token|service[-_]?account([-_]?json)?|client[-_]?secret|secret[-_]?id|unseal[-_]?key|recovery[-_]?key|key[-_]?file([-_]?path)?|token[-_]?file([-_]?path)?)$/i;
function rejectSensitiveProviderConfigKeys(value, ctx) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!deniedProviderConfigKeyPattern.test(key)) continue;
    ctx.addIssue({
      code: z6.ZodIssueCode.custom,
      path: ["config", key],
      message: `Provider vault config cannot persist sensitive field: ${key}`
    });
  }
}
var localEncryptedProviderConfigSchema = z6.object({
  backupReminderAcknowledged: z6.boolean().optional()
}).strict();
var awsSecretsManagerProviderConfigSchema = z6.object({
  region: z6.string().trim().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/, "Invalid AWS region"),
  namespace: optionalSafeShortText,
  secretNamePrefix: optionalSafeShortText,
  kmsKeyId: z6.string().trim().min(1).max(512).optional().nullable(),
  ownerTag: optionalSafeShortText,
  environmentTag: optionalSafeShortText
}).strict();
var gcpSecretManagerProviderConfigSchema = z6.object({
  projectId: z6.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9-]{4,127}$/).optional().nullable(),
  location: optionalSafeShortText,
  namespace: optionalSafeShortText,
  secretNamePrefix: optionalSafeShortText
}).strict();
var vaultAddressSchema = z6.preprocess(
  (value) => typeof value === "string" ? value.trim() : value,
  z6.string().url().superRefine((value, ctx) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    const hasPath = url.pathname !== "" && url.pathname !== "/";
    if (url.protocol !== "http:" && url.protocol !== "https:" || url.username || url.password || url.search || url.hash || hasPath) {
      ctx.addIssue({
        code: z6.ZodIssueCode.custom,
        message: "Vault address must be an origin-only HTTP(S) URL without credentials, path, query, or fragment"
      });
    }
  }).transform((value) => new URL(value).origin)
);
function rejectUnsafeVaultAddress(value, ctx) {
  if (value === void 0 || value === null) return;
  const parsed = vaultAddressSchema.safeParse(value);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      ...issue,
      path: ["config", "address", ...issue.path]
    });
  }
}
var vaultProviderConfigSchema = z6.object({
  address: vaultAddressSchema.optional().nullable(),
  namespace: optionalSafeShortText,
  mountPath: optionalSafeShortText,
  secretPathPrefix: optionalSafeShortText
}).strict();
var secretProviderConfigPayloadSchema = z6.discriminatedUnion("provider", [
  z6.object({ provider: z6.literal("local_encrypted"), config: localEncryptedProviderConfigSchema }),
  z6.object({ provider: z6.literal("aws_secrets_manager"), config: awsSecretsManagerProviderConfigSchema }),
  z6.object({ provider: z6.literal("gcp_secret_manager"), config: gcpSecretManagerProviderConfigSchema }),
  z6.object({ provider: z6.literal("vault"), config: vaultProviderConfigSchema })
]);
var createSecretProviderConfigSchema = z6.object({
  provider: z6.enum(SECRET_PROVIDERS),
  displayName: z6.string().trim().min(1).max(120),
  status: z6.enum(SECRET_PROVIDER_CONFIG_STATUSES).optional(),
  isDefault: z6.boolean().optional(),
  config: z6.record(z6.string(), z6.unknown()).default({})
}).superRefine((value, ctx) => {
  rejectSensitiveProviderConfigKeys(value.config, ctx);
  const parsed = secretProviderConfigPayloadSchema.safeParse({
    provider: value.provider,
    config: value.config
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        ...issue,
        path: issue.path[0] === "config" ? issue.path : ["config", ...issue.path]
      });
    }
  }
  const status = value.status ?? (["gcp_secret_manager", "vault"].includes(value.provider) ? "coming_soon" : "ready");
  if ((value.provider === "gcp_secret_manager" || value.provider === "vault") && status !== "coming_soon" && status !== "disabled") {
    ctx.addIssue({
      code: z6.ZodIssueCode.custom,
      path: ["status"],
      message: `${value.provider} provider vaults are locked while coming soon`
    });
  }
  if ((status === "coming_soon" || status === "disabled") && value.isDefault) {
    ctx.addIssue({
      code: z6.ZodIssueCode.custom,
      path: ["isDefault"],
      message: "Only ready or warning provider vaults can be default"
    });
  }
});
var updateSecretProviderConfigSchema = z6.object({
  displayName: z6.string().trim().min(1).max(120).optional(),
  status: z6.enum(SECRET_PROVIDER_CONFIG_STATUSES).optional(),
  isDefault: z6.boolean().optional(),
  config: z6.record(z6.string(), z6.unknown()).optional()
}).superRefine((value, ctx) => {
  if (value.config !== void 0) {
    rejectSensitiveProviderConfigKeys(value.config, ctx);
    rejectUnsafeVaultAddress(value.config.address, ctx);
  }
  if ((value.status === "coming_soon" || value.status === "disabled") && value.isDefault) {
    ctx.addIssue({
      code: z6.ZodIssueCode.custom,
      path: ["isDefault"],
      message: "Only ready or warning provider vaults can be default"
    });
  }
});
var remoteSecretImportPreviewSchema = z6.object({
  providerConfigId: z6.string().guid(),
  query: z6.string().trim().max(200).optional().nullable(),
  nextToken: z6.string().trim().min(1).max(4096).optional().nullable(),
  pageSize: z6.number().int().min(1).max(100).optional()
});
var secretProviderConfigDiscoveryPreviewSchema = z6.object({
  provider: z6.enum(SECRET_PROVIDERS),
  config: z6.record(z6.string(), z6.unknown()).default({}),
  query: z6.string().trim().max(200).optional().nullable(),
  nextToken: z6.string().trim().min(1).max(4096).optional().nullable(),
  pageSize: z6.number().int().min(1).max(100).optional()
}).superRefine((value, ctx) => {
  rejectSensitiveProviderConfigKeys(value.config, ctx);
  const parsed = secretProviderConfigPayloadSchema.safeParse({
    provider: value.provider,
    config: value.config
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        ...issue,
        path: issue.path[0] === "config" ? issue.path : ["config", ...issue.path]
      });
    }
  }
});
var remoteSecretImportSelectionSchema = z6.object({
  externalRef: z6.string().trim().min(1).max(2048),
  name: z6.string().trim().min(1).max(160).optional().nullable(),
  key: z6.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/).optional().nullable(),
  description: z6.string().trim().max(500).optional().nullable(),
  providerVersionRef: z6.string().trim().min(1).max(512).optional().nullable(),
  providerMetadata: z6.record(z6.string(), z6.unknown()).optional().nullable()
});
var remoteSecretImportSchema = z6.object({
  providerConfigId: z6.string().guid(),
  secrets: z6.array(remoteSecretImportSelectionSchema).min(1).max(100)
});

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/routine-variables.ts
var HUMAN_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "UTC",
  timeZoneName: "short"
});
function isValidRoutineDateString(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ][month - 1];
  return day >= 1 && day <= daysInMonth;
}

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/routine.ts
var routineVariableValueSchema = z7.union([z7.string(), z7.number().finite(), z7.boolean()]);
var routineVariableSchema = z7.object({
  name: z7.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  label: z7.string().trim().max(120).optional().nullable(),
  type: z7.enum(ROUTINE_VARIABLE_TYPES).optional().default("text"),
  defaultValue: routineVariableValueSchema.optional().nullable(),
  required: z7.boolean().optional().default(true),
  options: z7.array(z7.string().trim().min(1).max(120)).max(50).optional().default([])
}).superRefine((value, ctx) => {
  if (value.type === "select" && value.options.length === 0) {
    ctx.addIssue({
      code: z7.ZodIssueCode.custom,
      path: ["options"],
      message: "Select variables require at least one option"
    });
  }
  if (value.type !== "select" && value.options.length > 0) {
    ctx.addIssue({
      code: z7.ZodIssueCode.custom,
      path: ["options"],
      message: "Only select variables can define options"
    });
  }
  if (value.type === "select" && value.defaultValue != null) {
    if (typeof value.defaultValue !== "string" || !value.options.includes(value.defaultValue)) {
      ctx.addIssue({
        code: z7.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: "Select variable defaults must match one of the allowed options"
      });
    }
  }
  if (value.type === "date" && value.defaultValue != null) {
    if (typeof value.defaultValue !== "string" || !isValidRoutineDateString(value.defaultValue)) {
      ctx.addIssue({
        code: z7.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: "Date variable defaults must be valid YYYY-MM-DD calendar dates"
      });
    }
  }
});
var createRoutineSchema = z7.object({
  projectId: z7.string().guid().optional().nullable(),
  folderId: z7.string().guid().optional().nullable(),
  goalId: z7.string().guid().optional().nullable(),
  parentIssueId: z7.string().guid().optional().nullable(),
  title: z7.string().trim().min(1).max(200),
  description: z7.string().optional().nullable(),
  assigneeAgentId: z7.string().guid().optional().nullable(),
  priority: z7.enum(ISSUE_PRIORITIES).optional().default("medium"),
  status: z7.enum(ROUTINE_STATUSES).optional().default("active"),
  concurrencyPolicy: z7.enum(ROUTINE_CONCURRENCY_POLICIES).optional().default("coalesce_if_active"),
  catchUpPolicy: z7.enum(ROUTINE_CATCH_UP_POLICIES).optional().default("skip_missed"),
  activityGatePolicy: z7.enum(ROUTINE_ACTIVITY_GATE_POLICIES).optional(),
  activityGateScope: z7.enum(ROUTINE_ACTIVITY_GATE_SCOPES).optional(),
  variables: z7.array(routineVariableSchema).optional().default([]),
  env: envConfigSchema.optional().nullable()
});
var updateRoutineSchema = objectWithoutDefaults(createRoutineSchema).partial().extend({
  baseRevisionId: z7.string().guid().optional().nullable()
});
var routineRevisionSnapshotRoutineV1Schema = z7.object({
  id: z7.string().guid(),
  companyId: z7.string().guid(),
  projectId: z7.string().guid().nullable(),
  folderId: z7.string().guid().nullable().optional(),
  goalId: z7.string().guid().nullable(),
  parentIssueId: z7.string().guid().nullable(),
  title: z7.string().trim().min(1).max(200),
  description: z7.string().nullable(),
  assigneeAgentId: z7.string().guid().nullable(),
  priority: z7.enum(ISSUE_PRIORITIES),
  status: z7.enum(ROUTINE_STATUSES),
  concurrencyPolicy: z7.enum(ROUTINE_CONCURRENCY_POLICIES),
  catchUpPolicy: z7.enum(ROUTINE_CATCH_UP_POLICIES),
  activityGatePolicy: z7.enum(ROUTINE_ACTIVITY_GATE_POLICIES).default("always"),
  activityGateScope: z7.enum(ROUTINE_ACTIVITY_GATE_SCOPES).default("company"),
  variables: z7.array(routineVariableSchema),
  env: envConfigSchema.nullable().default(null),
  responsibleUserId: z7.string().nullable().default(null)
}).strict();
var routineRevisionSnapshotTriggerV1Schema = z7.object({
  id: z7.string().guid(),
  setupPending: z7.boolean().optional(),
  kind: z7.enum(ROUTINE_TRIGGER_KINDS),
  label: z7.string().nullable(),
  enabled: z7.boolean(),
  cronExpression: z7.string().nullable(),
  timezone: z7.string().nullable(),
  publicId: z7.string().nullable(),
  signingMode: z7.enum(ROUTINE_TRIGGER_SIGNING_MODES).nullable(),
  replayWindowSec: z7.number().int().min(30).max(86400).nullable()
}).strict();
var routineRevisionSnapshotV1Schema = z7.object({
  version: z7.literal(1),
  routine: routineRevisionSnapshotRoutineV1Schema,
  triggers: z7.array(routineRevisionSnapshotTriggerV1Schema)
}).strict();
var baseTriggerSchema = z7.object({
  label: z7.string().trim().max(120).optional().nullable(),
  enabled: z7.boolean().optional().default(true)
});
var createRoutineTriggerSchema = z7.discriminatedUnion("kind", [
  baseTriggerSchema.extend({
    kind: z7.literal("schedule"),
    cronExpression: z7.string().trim().min(1),
    timezone: z7.string().trim().min(1).default("UTC")
  }),
  baseTriggerSchema.extend({
    kind: z7.literal("webhook"),
    setupPending: z7.boolean().optional(),
    signingMode: z7.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().default("bearer"),
    replayWindowSec: z7.number().int().min(30).max(86400).optional().default(300)
  }),
  baseTriggerSchema.extend({
    kind: z7.literal("api")
  })
]);
var updateRoutineTriggerSchema = z7.object({
  setupPending: z7.literal(false).optional(),
  archived: z7.boolean().optional(),
  label: z7.string().trim().max(120).optional().nullable(),
  enabled: z7.boolean().optional(),
  cronExpression: z7.string().trim().min(1).optional().nullable(),
  timezone: z7.string().trim().min(1).optional().nullable(),
  signingMode: z7.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().nullable(),
  replayWindowSec: z7.number().int().min(30).max(86400).optional().nullable()
});
var runRoutineSchema = z7.object({
  triggerId: z7.string().guid().optional().nullable(),
  payload: z7.record(z7.string(), z7.unknown()).optional().nullable(),
  variables: z7.record(z7.string(), routineVariableValueSchema).optional().nullable(),
  projectId: z7.string().guid().optional().nullable(),
  projectWorkspaceId: z7.string().guid().optional().nullable(),
  assigneeAgentId: z7.string().guid().optional().nullable(),
  idempotencyKey: z7.string().trim().max(255).optional().nullable(),
  source: z7.enum(["manual", "api"]).optional().default("manual"),
  executionWorkspaceId: z7.string().guid().optional().nullable(),
  executionWorkspacePreference: z7.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional().nullable(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.optional().nullable()
});
var rotateRoutineTriggerSecretSchema = z7.object({});

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/external-object.ts
import { z as z8 } from "zod";
var externalObjectStatusCategorySchema = z8.enum(EXTERNAL_OBJECT_STATUS_CATEGORIES);
var externalObjectStatusToneSchema = z8.enum(EXTERNAL_OBJECT_STATUS_TONES);
var externalObjectLivenessStateSchema = z8.enum(EXTERNAL_OBJECT_LIVENESS_STATES);
var externalObjectMentionSourceKindSchema = z8.enum(EXTERNAL_OBJECT_MENTION_SOURCE_KINDS);
var externalObjectMentionConfidenceSchema = z8.enum(EXTERNAL_OBJECT_MENTION_CONFIDENCES);
var externalObjectProviderKeySchema = z8.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_.-]*$/);
var externalObjectTypeSchema = z8.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/);
var externalObjectCanonicalIdentitySchema = z8.object({
  scheme: z8.enum(["http", "https"]),
  host: z8.string().trim().min(1),
  path: z8.string().trim().min(1),
  queryParamHashes: z8.record(z8.string(), z8.string().regex(/^[a-f0-9]{64}$/)).optional()
}).strict();
var externalObjectMentionSourceSchema = z8.object({
  sourceKind: externalObjectMentionSourceKindSchema,
  documentKey: z8.string().trim().min(1).optional().nullable(),
  propertyKey: z8.string().trim().min(1).optional().nullable()
}).strict();

// ../build/fs4/upstream-seams-chatpool/packages/shared/src/validators/plugin.ts
var jsonSchemaSchema = z9.record(z9.string(), z9.unknown()).refine(
  (val) => {
    if (Object.keys(val).length === 0) return true;
    return typeof val.type === "string" || val.$ref !== void 0 || val.oneOf !== void 0 || val.anyOf !== void 0 || val.allOf !== void 0;
  },
  { message: "Must be a valid JSON Schema object (requires at least a 'type', '$ref', or composition keyword)" }
);
var CRON_FIELD_PATTERN = /^(\*(?:\/[0-9]+)?|[0-9]+(?:-[0-9]+)?(?:\/[0-9]+)?)(?:,(\*(?:\/[0-9]+)?|[0-9]+(?:-[0-9]+)?(?:\/[0-9]+)?))*$/;
function isValidCronExpression(expression) {
  const trimmed = expression.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => CRON_FIELD_PATTERN.test(f));
}
var pluginJobDeclarationSchema = z9.object({
  jobKey: z9.string().min(1),
  displayName: z9.string().min(1),
  description: z9.string().optional(),
  schedule: z9.string().refine(
    (val) => isValidCronExpression(val),
    { message: "schedule must be a valid 5-field cron expression (e.g. '*/15 * * * *')" }
  ).optional()
});
var pluginWebhookDeclarationSchema = z9.object({
  endpointKey: z9.string().min(1),
  displayName: z9.string().min(1),
  description: z9.string().optional()
});
var pluginToolDeclarationSchema = z9.object({
  name: z9.string().min(1),
  displayName: z9.string().min(1),
  description: z9.string().min(1),
  parametersSchema: jsonSchemaSchema
});
var pluginEnvironmentTemplateConfigFieldSchema = z9.string().min(1).max(100).regex(
  /^[A-Za-z_][A-Za-z0-9_-]*$/,
  "Template config binding fields must be top-level config keys using letters, digits, underscores, or hyphens"
).refine((value) => value !== "provider", {
  message: "Template config binding must not replace the sandbox provider key"
});
var pluginEnvironmentTemplateConfigBindingSchema = z9.object({
  field: pluginEnvironmentTemplateConfigFieldSchema,
  unsetFields: z9.array(pluginEnvironmentTemplateConfigFieldSchema).max(20).optional()
}).strict().superRefine((value, ctx) => {
  const unsetFields = value.unsetFields ?? [];
  const seen = /* @__PURE__ */ new Set();
  for (const [index, field] of unsetFields.entries()) {
    if (field === value.field) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "Template config binding cannot unset the same field it sets",
        path: ["unsetFields", index]
      });
    }
    if (seen.has(field)) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "Template config binding unsetFields must be unique",
        path: ["unsetFields", index]
      });
    }
    seen.add(field);
  }
});
var sandboxProviderCapabilitiesSchema = z9.object({
  reusableLeases: z9.boolean().optional(),
  nativeSyncIn: z9.boolean().optional(),
  nativeSyncOut: z9.boolean().optional(),
  persistentProcessSessions: z9.boolean().optional(),
  independentControlCommands: z9.boolean().optional(),
  incrementalSessionOutput: z9.boolean().optional(),
  concurrentSyncOperations: z9.boolean().optional(),
  duplexCommandStream: z9.boolean().optional(),
  runnerWebSocketIngress: z9.boolean().optional()
}).strict();
var pluginEnvironmentDriverDeclarationSchema = z9.object({
  skillKeys: z9.array(z9.string().min(1).max(100)).max(100).optional(),
  requiresAgent: z9.boolean().optional(),
  supportsTasks: z9.boolean().optional(),
  freshWorkspaceVersion: z9.literal(1).optional(),
  warmTaskVersion: z9.literal(1).optional(),
  driverKey: z9.string().min(1).regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Environment driver key must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, hyphens, or underscores"
  ),
  kind: z9.enum(["environment_driver", "sandbox_provider"]).optional(),
  displayName: z9.string().min(1).max(100),
  description: z9.string().max(500).optional(),
  defaultAcquireTimeoutMs: z9.number().int().positive().max(864e5).optional(),
  supportsReusableLeases: z9.boolean().optional(),
  sandboxCapabilities: sandboxProviderCapabilitiesSchema.optional(),
  supportsInteractiveSetup: z9.boolean().optional(),
  interactiveSetupConnectionTypes: z9.array(z9.string().min(1).max(100)).max(10).optional(),
  supportsTemplateCapture: z9.boolean().optional(),
  templateRefKind: z9.string().min(1).max(100).optional(),
  templateConfigBinding: pluginEnvironmentTemplateConfigBindingSchema.optional(),
  templateIdentityPaths: z9.array(z9.string().min(1).max(200)).max(20).optional(),
  supportsTemplateDelete: z9.boolean().optional(),
  // The neutral transport capability: does the provider host an interactive
  // login on a real pseudo-terminal? Validate a literal boolean only.
  supportsLoginPty: z9.boolean().optional(),
  // Deprecated alias for `supportsLoginPty`. It exists only so an external
  // plugin manifest that declares the old name still loads. Validate a literal
  // boolean only. The transform below canonicalizes it onto `supportsLoginPty`
  // and drops it, so every downstream reader reads only the canonical field.
  supportsSetupTokenLogin: z9.boolean().optional(),
  configSchema: jsonSchemaSchema
}).strict().superRefine((driver, ctx) => {
  if (driver.supportsLoginPty !== void 0 && driver.supportsSetupTokenLogin !== void 0 && driver.supportsLoginPty !== driver.supportsSetupTokenLogin) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "supportsSetupTokenLogin is a deprecated alias for supportsLoginPty; the two flags must not carry different values",
      path: ["supportsLoginPty"]
    });
  }
}).transform((driver) => {
  const { supportsSetupTokenLogin, ...rest } = driver;
  return { ...rest, supportsLoginPty: rest.supportsLoginPty ?? supportsSetupTokenLogin };
});
var pluginManagedAgentDeclarationSchema = z9.object({
  agentKey: z9.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "agentKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens"
  }),
  displayName: z9.string().min(1).max(100),
  role: z9.string().min(1).max(100).optional(),
  title: z9.string().max(200).nullable().optional(),
  icon: z9.string().max(100).nullable().optional(),
  capabilities: z9.string().max(2e3).nullable().optional(),
  adapterType: z9.string().min(1).max(100).optional(),
  adapterPreference: z9.array(z9.string().min(1).max(100)).max(10).optional(),
  adapterConfig: z9.record(z9.string(), z9.unknown()).optional(),
  runtimeConfig: z9.record(z9.string(), z9.unknown()).optional(),
  permissions: z9.record(z9.string(), z9.unknown()).optional(),
  status: z9.enum(["idle", "paused"]).optional(),
  budgetMonthlyCents: z9.number().int().min(0).optional(),
  instructions: z9.object({
    entryFile: z9.string().min(1).max(200).optional(),
    content: z9.string().max(2e5).optional(),
    files: z9.record(z9.string(), z9.string().max(2e5)).optional(),
    assetPath: z9.string().min(1).max(500).optional()
  }).optional()
});
var pluginManagedProjectDeclarationSchema = z9.object({
  projectKey: z9.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "projectKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens"
  }),
  displayName: z9.string().min(1).max(120),
  description: z9.string().max(2e3).nullable().optional(),
  status: z9.enum(["backlog", "planned", "in_progress", "completed", "cancelled"]).optional(),
  color: z9.string().max(32).nullable().optional(),
  settings: z9.record(z9.string(), z9.unknown()).optional()
});
var pluginManagedResourceRefSchema = z9.object({
  pluginKey: z9.string().min(1).max(100).optional(),
  resourceKind: z9.enum(["agent", "project", "routine", "skill"]),
  resourceKey: z9.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "resourceKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens"
  })
});
var pluginManagedRoutineDeclarationSchema = z9.object({
  routineKey: z9.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "routineKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens"
  }),
  title: z9.string().trim().min(1).max(200),
  description: z9.string().max(1e4).nullable().optional(),
  assigneeRef: pluginManagedResourceRefSchema.extend({ resourceKind: z9.literal("agent") }).nullable().optional(),
  projectRef: pluginManagedResourceRefSchema.extend({ resourceKind: z9.literal("project") }).nullable().optional(),
  goalId: z9.string().guid().nullable().optional(),
  status: z9.enum(ROUTINE_STATUSES).optional(),
  priority: z9.enum(ISSUE_PRIORITIES).optional(),
  concurrencyPolicy: z9.enum(ROUTINE_CONCURRENCY_POLICIES).optional(),
  catchUpPolicy: z9.enum(ROUTINE_CATCH_UP_POLICIES).optional(),
  activityGatePolicy: z9.enum(ROUTINE_ACTIVITY_GATE_POLICIES).optional(),
  activityGateScope: z9.enum(ROUTINE_ACTIVITY_GATE_SCOPES).optional(),
  variables: z9.array(routineVariableSchema).optional(),
  triggers: z9.array(z9.object({
    kind: z9.enum(ROUTINE_TRIGGER_KINDS),
    label: z9.string().trim().max(120).nullable().optional(),
    enabled: z9.boolean().optional(),
    cronExpression: z9.string().trim().min(1).optional().nullable(),
    timezone: z9.string().trim().min(1).optional().nullable(),
    signingMode: z9.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().nullable(),
    replayWindowSec: z9.number().int().min(30).max(86400).optional().nullable()
  })).max(20).optional(),
  issueTemplate: z9.object({
    surfaceVisibility: z9.enum(ISSUE_SURFACE_VISIBILITIES).optional(),
    originId: z9.string().trim().max(255).nullable().optional(),
    billingCode: z9.string().trim().max(200).nullable().optional()
  }).optional()
});
var pluginLocalFolderRelativePathSchema = z9.string().min(1).max(500).refine(
  (value) => !value.startsWith("/") && !value.includes("..") && !value.includes("\\") && !value.split("/").some((segment) => segment === "" || segment === "."),
  { message: "local folder paths must be relative paths without traversal, empty segments, or backslashes" }
);
var pluginLocalFolderDeclarationSchema = z9.object({
  folderKey: z9.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "folderKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens"
  }),
  displayName: z9.string().min(1).max(100),
  description: z9.string().max(500).optional(),
  access: z9.enum(["read", "readWrite"]).optional(),
  requiredDirectories: z9.array(pluginLocalFolderRelativePathSchema).optional(),
  requiredFiles: z9.array(pluginLocalFolderRelativePathSchema).optional()
});
var pluginManagedSkillFileDeclarationSchema = z9.object({
  path: pluginLocalFolderRelativePathSchema.refine(
    (value) => value.toLowerCase() !== "skill.md",
    { message: "managed skill files cannot replace SKILL.md; use markdown for the main skill file" }
  ),
  content: z9.string().max(2e5)
});
var pluginManagedSkillDeclarationSchema = z9.object({
  skillKey: z9.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "skillKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens"
  }),
  displayName: z9.string().min(1).max(100),
  slug: z9.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "slug must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens"
  }).optional(),
  description: z9.string().max(2e3).nullable().optional(),
  markdown: z9.string().max(2e5).optional(),
  files: z9.array(pluginManagedSkillFileDeclarationSchema).max(50).optional()
}).superRefine((value, ctx) => {
  const paths = (value.files ?? []).map((file) => file.path);
  const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index);
  if (duplicates.length > 0) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: `Duplicate managed skill file paths: ${[...new Set(duplicates)].join(", ")}`,
      path: ["files"]
    });
  }
});
var pluginUiSlotDeclarationSchema = z9.object({
  type: z9.enum(PLUGIN_UI_SLOT_TYPES),
  id: z9.string().min(1),
  displayName: z9.string().min(1),
  exportName: z9.string().min(1),
  entityTypes: z9.array(z9.enum(PLUGIN_UI_SLOT_ENTITY_TYPES)).optional(),
  taskSidePanel: z9.object({
    availabilityPath: z9.string().regex(/^\/(?:[a-zA-Z0-9_-]+\/)*:entityId(?:\/[a-zA-Z0-9_-]+)*$/)
  }).strict().optional(),
  routePath: z9.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "routePath must be a lowercase single-segment slug (letters, numbers, hyphens)"
  }).optional(),
  order: z9.number().int().optional()
}).superRefine((value, ctx) => {
  if (value.taskSidePanel && (value.type !== "detailTab" || !value.entityTypes?.includes("agent"))) {
    ctx.addIssue({ code: z9.ZodIssueCode.custom, message: "taskSidePanel requires an agent detailTab", path: ["taskSidePanel"] });
  }
  const entityScopedTypes = ["detailTab", "taskDetailView", "contextMenuItem", "commentAnnotation", "commentContextMenuItem", "projectSidebarItem"];
  if (entityScopedTypes.includes(value.type) && (!value.entityTypes || value.entityTypes.length === 0)) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: `${value.type} slots require at least one entityType`,
      path: ["entityTypes"]
    });
  }
  if (value.type === "projectSidebarItem" && value.entityTypes && !value.entityTypes.includes("project")) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: 'projectSidebarItem slots require entityTypes to include "project"',
      path: ["entityTypes"]
    });
  }
  if (value.type === "commentAnnotation" && value.entityTypes && !value.entityTypes.includes("comment")) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: 'commentAnnotation slots require entityTypes to include "comment"',
      path: ["entityTypes"]
    });
  }
  if (value.type === "commentContextMenuItem" && value.entityTypes && !value.entityTypes.includes("comment")) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: 'commentContextMenuItem slots require entityTypes to include "comment"',
      path: ["entityTypes"]
    });
  }
  if (value.routePath && value.type !== "page" && value.type !== "routeSidebar" && value.type !== "companySettingsPage") {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "routePath is only supported for page, routeSidebar, and companySettingsPage slots",
      path: ["routePath"]
    });
  }
  if (value.type === "routeSidebar" && !value.routePath) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "routeSidebar slots require routePath",
      path: ["routePath"]
    });
  }
  if (value.type === "companySettingsPage" && !value.routePath) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "companySettingsPage slots require routePath",
      path: ["routePath"]
    });
  }
  if (value.routePath && PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS.includes(value.routePath)) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: `routePath "${value.routePath}" is reserved by the host`,
      path: ["routePath"]
    });
  }
  if (value.type === "companySettingsPage" && value.routePath && PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS.includes(value.routePath)) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: `company settings routePath "${value.routePath}" is reserved by the host`,
      path: ["routePath"]
    });
  }
});
var entityScopedLauncherPlacementZones = [
  "detailTab",
  "taskDetailView",
  "contextMenuItem",
  "commentAnnotation",
  "commentContextMenuItem",
  "projectSidebarItem"
];
var launcherBoundsByEnvironment = {
  hostInline: ["inline", "compact", "default"],
  hostOverlay: ["compact", "default", "wide", "full"],
  hostRoute: ["default", "wide", "full"],
  external: [],
  iframe: ["compact", "default", "wide", "full"]
};
var pluginLauncherActionDeclarationSchema = z9.object({
  type: z9.enum(PLUGIN_LAUNCHER_ACTIONS),
  target: z9.string().min(1),
  params: z9.record(z9.string(), z9.unknown()).optional()
}).superRefine((value, ctx) => {
  if (value.type === "performAction" && value.target.includes("/")) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "performAction launchers must target an action key, not a route or URL",
      path: ["target"]
    });
  }
  if (value.type === "navigate" && /^https?:\/\//.test(value.target)) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "navigate launchers must target a host route, not an absolute URL",
      path: ["target"]
    });
  }
});
var pluginLauncherRenderDeclarationSchema = z9.object({
  environment: z9.enum(PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS),
  bounds: z9.enum(PLUGIN_LAUNCHER_BOUNDS).optional()
}).superRefine((value, ctx) => {
  if (!value.bounds) {
    return;
  }
  const supportedBounds = launcherBoundsByEnvironment[value.environment];
  if (!supportedBounds.includes(value.bounds)) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: `bounds "${value.bounds}" is not supported for render environment "${value.environment}"`,
      path: ["bounds"]
    });
  }
});
var pluginLauncherDeclarationSchema = z9.object({
  id: z9.string().min(1),
  displayName: z9.string().min(1),
  description: z9.string().optional(),
  placementZone: z9.enum(PLUGIN_LAUNCHER_PLACEMENT_ZONES),
  exportName: z9.string().min(1).optional(),
  entityTypes: z9.array(z9.enum(PLUGIN_UI_SLOT_ENTITY_TYPES)).optional(),
  order: z9.number().int().optional(),
  action: pluginLauncherActionDeclarationSchema,
  render: pluginLauncherRenderDeclarationSchema.optional()
}).superRefine((value, ctx) => {
  if (entityScopedLauncherPlacementZones.some((zone) => zone === value.placementZone) && (!value.entityTypes || value.entityTypes.length === 0)) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: `${value.placementZone} launchers require at least one entityType`,
      path: ["entityTypes"]
    });
  }
  if (value.placementZone === "projectSidebarItem" && value.entityTypes && !value.entityTypes.includes("project")) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: 'projectSidebarItem launchers require entityTypes to include "project"',
      path: ["entityTypes"]
    });
  }
  if (value.action.type === "performAction" && value.render) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "performAction launchers cannot declare render hints",
      path: ["render"]
    });
  }
  if (["openModal", "openDrawer", "openPopover"].includes(value.action.type) && !value.render) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: `${value.action.type} launchers require render metadata`,
      path: ["render"]
    });
  }
  if (value.action.type === "openModal" && value.render?.environment === "hostInline") {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "openModal launchers cannot use the hostInline render environment",
      path: ["render", "environment"]
    });
  }
  if (value.action.type === "openDrawer" && value.render && !["hostOverlay", "iframe"].includes(value.render.environment)) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "openDrawer launchers must use hostOverlay or iframe render environments",
      path: ["render", "environment"]
    });
  }
  if (value.action.type === "openPopover" && value.render?.environment === "hostRoute") {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "openPopover launchers cannot use the hostRoute render environment",
      path: ["render", "environment"]
    });
  }
});
var pluginDatabaseDeclarationSchema = z9.object({
  namespaceSlug: z9.string().regex(/^[a-z0-9][a-z0-9_]*$/, {
    message: "namespaceSlug must be lowercase letters, digits, or underscores and start with a letter or digit"
  }).max(40).optional(),
  migrationsDir: z9.string().min(1).refine(
    (value) => !value.startsWith("/") && !value.includes("..") && !/[\\]/.test(value),
    { message: "migrationsDir must be a relative package path without '..' or backslashes" }
  ),
  coreReadTables: z9.array(z9.enum(PLUGIN_DATABASE_CORE_READ_TABLES)).optional()
});
var pluginApiRouteDeclarationSchema = z9.object({
  routeKey: z9.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "routeKey must be lowercase letters, digits, dots, colons, underscores, or hyphens"
  }),
  method: z9.enum(PLUGIN_API_ROUTE_METHODS),
  transport: z9.literal("websocket").optional(),
  path: z9.string().min(1).regex(/^\/[a-zA-Z0-9:_./-]*$/, {
    message: "path must start with / and contain only path-safe literal or :param segments"
  }).refine(
    (value) => !value.includes("..") && !value.includes("//") && value !== "/api" && !value.startsWith("/api/") && value !== "/plugins" && !value.startsWith("/plugins/"),
    { message: "path must stay inside the plugin api namespace" }
  ),
  auth: z9.enum(PLUGIN_API_ROUTE_AUTH_MODES),
  capability: z9.literal("api.routes.register"),
  checkoutPolicy: z9.enum(PLUGIN_API_ROUTE_CHECKOUT_POLICIES).optional(),
  companyResolution: z9.discriminatedUnion("from", [
    z9.object({ from: z9.literal("body"), key: z9.string().min(1) }),
    z9.object({ from: z9.literal("query"), key: z9.string().min(1) }),
    z9.object({ from: z9.literal("issue"), param: z9.string().min(1) }),
    z9.object({ from: z9.literal("agent"), param: z9.string().min(1) })
  ]).optional()
}).refine((route) => !route.transport || route.method === "GET" && route.auth === "board", { message: "WebSocket routes require GET and board authentication" }).refine((route) => !route.transport || route.companyResolution?.from !== "body", {
  message: "WebSocket routes cannot resolve company from a request body",
  path: ["companyResolution"]
});
var pluginObjectReferenceRefreshPolicySchema = z9.object({
  defaultTtlSeconds: z9.number().int().positive().max(86400).optional(),
  staleAfterSeconds: z9.number().int().positive().max(604800).optional()
}).superRefine((value, ctx) => {
  if (value.defaultTtlSeconds != null && value.staleAfterSeconds != null && value.staleAfterSeconds < value.defaultTtlSeconds) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "staleAfterSeconds must be greater than or equal to defaultTtlSeconds",
      path: ["staleAfterSeconds"]
    });
  }
});
var pluginObjectReferenceProviderDeclarationSchema = z9.object({
  providerKey: externalObjectProviderKeySchema,
  displayName: z9.string().min(1).max(100),
  objectTypes: z9.array(externalObjectTypeSchema).min(1),
  urlPatterns: z9.array(z9.string().trim().min(1).max(500)).optional(),
  refreshPolicy: pluginObjectReferenceRefreshPolicySchema.optional(),
  webhookEndpointKeys: z9.array(z9.string().min(1)).optional()
}).superRefine((value, ctx) => {
  const duplicateObjectTypes = value.objectTypes.filter((type, i) => value.objectTypes.indexOf(type) !== i);
  if (duplicateObjectTypes.length > 0) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: `Duplicate objectTypes: ${[...new Set(duplicateObjectTypes)].join(", ")}`,
      path: ["objectTypes"]
    });
  }
  const webhookKeys = value.webhookEndpointKeys ?? [];
  const duplicateWebhookKeys = webhookKeys.filter((key, i) => webhookKeys.indexOf(key) !== i);
  if (duplicateWebhookKeys.length > 0) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: `Duplicate webhookEndpointKeys: ${[...new Set(duplicateWebhookKeys)].join(", ")}`,
      path: ["webhookEndpointKeys"]
    });
  }
});
var pluginManifestV1Schema = z9.object({
  id: z9.string().min(1).regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Plugin id must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, hyphens, or underscores"
  ),
  apiVersion: z9.literal(1),
  version: z9.string().min(1).regex(
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    "Version must follow semver (e.g. 1.0.0 or 1.0.0-beta.1)"
  ),
  displayName: z9.string().min(1).max(100),
  description: z9.string().min(1).max(500),
  author: z9.string().min(1).max(200),
  categories: z9.array(z9.enum(PLUGIN_CATEGORIES)).min(1),
  minimumHostVersion: z9.string().regex(
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    "minimumHostVersion must follow semver (e.g. 1.0.0)"
  ).optional(),
  minimumPaperclipVersion: z9.string().regex(
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    "minimumPaperclipVersion must follow semver (e.g. 1.0.0)"
  ).optional(),
  capabilities: z9.array(z9.enum(PLUGIN_CAPABILITIES)).min(1),
  agentLifecycle: z9.literal(true).optional(),
  workspaceProvider: z9.object({
    finalizationVersion: z9.literal(1).optional(),
    freshWorkspaceVersion: z9.literal(1).optional(),
    modes: z9.array(z9.enum(["shared_workspace", "isolated_workspace", "operator_branch"])).min(1).max(3),
    strategies: z9.array(z9.enum(["project_primary", "git_worktree"])).min(1).max(2),
    defaultForProjects: z9.object({
      mode: z9.enum(["shared_workspace", "isolated_workspace", "operator_branch"]),
      strategy: z9.enum(["project_primary", "git_worktree"])
    }).strict().optional()
  }).strict().optional(),
  resourceLifecycle: z9.array(z9.enum(["agent", "project", "agent_runtime"])).min(1).max(3).optional(),
  aiConnectionRouter: z9.object({ name: z9.string().trim().min(1).max(100), description: z9.string().trim().min(1).max(500) }).strict().optional(),
  entrypoints: z9.object({
    worker: z9.string().min(1),
    ui: z9.string().min(1).optional()
  }),
  instanceConfigSchema: jsonSchemaSchema.optional(),
  jobs: z9.array(pluginJobDeclarationSchema).optional(),
  webhooks: z9.array(pluginWebhookDeclarationSchema).optional(),
  tools: z9.array(pluginToolDeclarationSchema).optional(),
  database: pluginDatabaseDeclarationSchema.optional(),
  apiRoutes: z9.array(pluginApiRouteDeclarationSchema).optional(),
  environmentDrivers: z9.array(pluginEnvironmentDriverDeclarationSchema).optional(),
  agents: z9.array(pluginManagedAgentDeclarationSchema).optional(),
  projects: z9.array(pluginManagedProjectDeclarationSchema).optional(),
  routines: z9.array(pluginManagedRoutineDeclarationSchema).optional(),
  skills: z9.array(pluginManagedSkillDeclarationSchema).optional(),
  localFolders: z9.array(pluginLocalFolderDeclarationSchema).optional(),
  objectReferences: z9.array(pluginObjectReferenceProviderDeclarationSchema).optional(),
  launchers: z9.array(pluginLauncherDeclarationSchema).optional(),
  ui: z9.object({
    slots: z9.array(pluginUiSlotDeclarationSchema).min(1).optional(),
    launchers: z9.array(pluginLauncherDeclarationSchema).optional()
  }).optional()
}).superRefine((manifest, ctx) => {
  if (manifest.environmentDrivers?.some((driver) => driver.requiresAgent) && !manifest.agentLifecycle) {
    ctx.addIssue({ code: z9.ZodIssueCode.custom, message: "Agent-dependent environments require agent lifecycle participation", path: ["agentLifecycle"] });
  }
  if (manifest.agentLifecycle && !manifest.capabilities.includes("agents.lifecycle.manage")) {
    ctx.addIssue({ code: z9.ZodIssueCode.custom, message: "Agent lifecycle participation requires agents.lifecycle.manage", path: ["capabilities"] });
  }
  if (manifest.workspaceProvider && (!manifest.capabilities.includes("workspaces.manage") || !manifest.resourceLifecycle?.includes("project"))) {
    ctx.addIssue({ code: z9.ZodIssueCode.custom, path: ["workspaceProvider"], message: "Workspace providers require workspaces.manage and project resource lifecycle" });
  }
  const defaults = manifest.workspaceProvider?.defaultForProjects;
  if (defaults && (!manifest.workspaceProvider.modes.includes(defaults.mode) || !manifest.workspaceProvider.strategies.includes(defaults.strategy))) {
    ctx.addIssue({ code: z9.ZodIssueCode.custom, path: ["workspaceProvider", "defaultForProjects"], message: "Project defaults must use a declared workspace mode and strategy" });
  }
  if (manifest.resourceLifecycle && !manifest.capabilities.includes("events.subscribe")) {
    ctx.addIssue({ code: z9.ZodIssueCode.custom, message: "Resource lifecycle delivery requires events.subscribe", path: ["capabilities"] });
  }
  const hasUiSlots = (manifest.ui?.slots?.length ?? 0) > 0;
  const hasUiLaunchers = (manifest.ui?.launchers?.length ?? 0) > 0;
  if ((hasUiSlots || hasUiLaunchers) && !manifest.entrypoints.ui) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "entrypoints.ui is required when ui.slots or ui.launchers are declared",
      path: ["entrypoints", "ui"]
    });
  }
  if (manifest.minimumHostVersion && manifest.minimumPaperclipVersion && manifest.minimumHostVersion !== manifest.minimumPaperclipVersion) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "minimumHostVersion and minimumPaperclipVersion must match when both are declared",
      path: ["minimumHostVersion"]
    });
  }
  if (manifest.aiConnectionRouter && !manifest.capabilities.includes("ai.connections.route")) {
    ctx.addIssue({ code: z9.ZodIssueCode.custom, message: "ai.connections.route is required for aiConnectionRouter", path: ["capabilities"] });
  }
  if (manifest.tools && manifest.tools.length > 0) {
    if (!manifest.capabilities.includes("agent.tools.register")) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "Capability 'agent.tools.register' is required when tools are declared",
        path: ["capabilities"]
      });
    }
  }
  if (manifest.environmentDrivers && manifest.environmentDrivers.length > 0) {
    if (!manifest.capabilities.includes("environment.drivers.register")) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "Capability 'environment.drivers.register' is required when environmentDrivers are declared",
        path: ["capabilities"]
      });
    }
  }
  for (const [index, driver] of (manifest.environmentDrivers ?? []).entries()) {
    const keys = driver.skillKeys ?? [];
    if (new Set(keys).size !== keys.length || keys.some((key) => !manifest.skills?.some((skill) => skill.skillKey === key))) {
      ctx.addIssue({ code: z9.ZodIssueCode.custom, message: "Environment skill keys must be unique references to this plugin's managed skills", path: ["environmentDrivers", index, "skillKeys"] });
    }
  }
  if (manifest.agents && manifest.agents.length > 0) {
    if (!manifest.capabilities.includes("agents.managed")) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "Capability 'agents.managed' is required when managed agents are declared",
        path: ["capabilities"]
      });
    }
  }
  if (manifest.projects && manifest.projects.length > 0) {
    if (!manifest.capabilities.includes("projects.managed")) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "Capability 'projects.managed' is required when managed projects are declared",
        path: ["capabilities"]
      });
    }
  }
  if (manifest.routines && manifest.routines.length > 0) {
    if (!manifest.capabilities.includes("routines.managed")) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "Capability 'routines.managed' is required when managed routines are declared",
        path: ["capabilities"]
      });
    }
  }
  if (manifest.skills && manifest.skills.length > 0) {
    if (!manifest.capabilities.includes("skills.managed")) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "Capability 'skills.managed' is required when managed skills are declared",
        path: ["capabilities"]
      });
    }
  }
  if (manifest.localFolders && manifest.localFolders.length > 0) {
    if (!manifest.capabilities.includes("local.folders")) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "Capability 'local.folders' is required when local folders are declared",
        path: ["capabilities"]
      });
    }
  }
  if (manifest.jobs && manifest.jobs.length > 0) {
    if (!manifest.capabilities.includes("jobs.schedule")) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "Capability 'jobs.schedule' is required when jobs are declared",
        path: ["capabilities"]
      });
    }
  }
  if (manifest.webhooks && manifest.webhooks.length > 0) {
    if (!manifest.capabilities.includes("webhooks.receive")) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "Capability 'webhooks.receive' is required when webhooks are declared",
        path: ["capabilities"]
      });
    }
  }
  for (const [index, slot] of (manifest.ui?.slots ?? []).entries()) {
    if (!slot.taskSidePanel) continue;
    const route = manifest.apiRoutes?.find((route2) => route2.path === slot.taskSidePanel.availabilityPath && route2.method === "GET");
    if (!route || route.auth !== "board" || route.transport || route.companyResolution?.from !== "agent" || route.companyResolution.param !== "entityId") {
      ctx.addIssue({ code: z9.ZodIssueCode.custom, message: "taskSidePanel availability requires a declared board GET route scoped to agent :entityId", path: ["ui", "slots", index, "taskSidePanel"] });
    }
  }
  if (manifest.apiRoutes?.some((route) => route.transport === "websocket") && !manifest.capabilities.includes("http.outbound")) {
    ctx.addIssue({ code: z9.ZodIssueCode.custom, message: "WebSocket routes require http.outbound", path: ["capabilities"] });
  }
  if (manifest.apiRoutes && manifest.apiRoutes.length > 0) {
    if (!manifest.capabilities.includes("api.routes.register")) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "Capability 'api.routes.register' is required when apiRoutes are declared",
        path: ["capabilities"]
      });
    }
  }
  if (manifest.objectReferences && manifest.objectReferences.length > 0) {
    for (const capability of ["external.objects.detect", "external.objects.read"]) {
      if (!manifest.capabilities.includes(capability)) {
        ctx.addIssue({
          code: z9.ZodIssueCode.custom,
          message: `Capability '${capability}' is required when objectReferences are declared`,
          path: ["capabilities"]
        });
      }
    }
    const declaredWebhookKeys = new Set((manifest.webhooks ?? []).map((webhook) => webhook.endpointKey));
    for (const [providerIndex, provider] of manifest.objectReferences.entries()) {
      for (const endpointKey of provider.webhookEndpointKeys ?? []) {
        if (!declaredWebhookKeys.has(endpointKey)) {
          ctx.addIssue({
            code: z9.ZodIssueCode.custom,
            message: `objectReferences webhookEndpointKey "${endpointKey}" must match a declared webhook endpoint`,
            path: ["objectReferences", providerIndex, "webhookEndpointKeys"]
          });
        }
      }
    }
  }
  if (manifest.database) {
    const requiredCapabilities = [
      "database.namespace.migrate",
      "database.namespace.read"
    ];
    for (const capability of requiredCapabilities) {
      if (!manifest.capabilities.includes(capability)) {
        ctx.addIssue({
          code: z9.ZodIssueCode.custom,
          message: `Capability '${capability}' is required when database migrations are declared`,
          path: ["capabilities"]
        });
      }
    }
    const coreReadTables = manifest.database.coreReadTables ?? [];
    const duplicates = coreReadTables.filter((table, i) => coreReadTables.indexOf(table) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate database coreReadTables: ${[...new Set(duplicates)].join(", ")}`,
        path: ["database", "coreReadTables"]
      });
    }
  }
  if (manifest.jobs) {
    const jobKeys = manifest.jobs.map((j) => j.jobKey);
    const duplicates = jobKeys.filter((key, i) => jobKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate job keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["jobs"]
      });
    }
  }
  if (manifest.webhooks) {
    const endpointKeys = manifest.webhooks.map((w) => w.endpointKey);
    const duplicates = endpointKeys.filter((key, i) => endpointKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate webhook endpoint keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["webhooks"]
      });
    }
  }
  if (manifest.apiRoutes) {
    const routeKeys = manifest.apiRoutes.map((route) => route.routeKey);
    const duplicateKeys = routeKeys.filter((key, i) => routeKeys.indexOf(key) !== i);
    if (duplicateKeys.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate api route keys: ${[...new Set(duplicateKeys)].join(", ")}`,
        path: ["apiRoutes"]
      });
    }
    const routeSignatures = manifest.apiRoutes.map((route) => `${route.method} ${route.path}`);
    const duplicateRoutes = routeSignatures.filter((sig, i) => routeSignatures.indexOf(sig) !== i);
    if (duplicateRoutes.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate api routes: ${[...new Set(duplicateRoutes)].join(", ")}`,
        path: ["apiRoutes"]
      });
    }
  }
  if (manifest.tools) {
    const toolNames = manifest.tools.map((t) => t.name);
    const duplicates = toolNames.filter((name, i) => toolNames.indexOf(name) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate tool names: ${[...new Set(duplicates)].join(", ")}`,
        path: ["tools"]
      });
    }
  }
  if (manifest.environmentDrivers) {
    const driverKeys = manifest.environmentDrivers.map((d) => d.driverKey);
    const duplicates = driverKeys.filter((key, i) => driverKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate environment driver keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["environmentDrivers"]
      });
    }
  }
  if (manifest.localFolders) {
    const folderKeys = manifest.localFolders.map((folder) => folder.folderKey);
    const duplicates = folderKeys.filter((key, i) => folderKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate local folder keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["localFolders"]
      });
    }
  }
  if (manifest.agents) {
    const agentKeys = manifest.agents.map((agent) => agent.agentKey);
    const duplicates = agentKeys.filter((key, i) => agentKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate managed agent keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["agents"]
      });
    }
  }
  if (manifest.projects) {
    const projectKeys = manifest.projects.map((project) => project.projectKey);
    const duplicates = projectKeys.filter((key, i) => projectKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate managed project keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["projects"]
      });
    }
  }
  if (manifest.routines) {
    const routineKeys = manifest.routines.map((routine) => routine.routineKey);
    const duplicates = routineKeys.filter((key, i) => routineKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate managed routine keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["routines"]
      });
    }
  }
  if (manifest.skills) {
    const skillKeys = manifest.skills.map((skill) => skill.skillKey);
    const duplicates = skillKeys.filter((key, i) => skillKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate managed skill keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["skills"]
      });
    }
  }
  if (manifest.objectReferences) {
    const providerKeys = manifest.objectReferences.map((provider) => provider.providerKey);
    const duplicateProviders = providerKeys.filter((key, i) => providerKeys.indexOf(key) !== i);
    if (duplicateProviders.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate object reference provider keys: ${[...new Set(duplicateProviders)].join(", ")}`,
        path: ["objectReferences"]
      });
    }
  }
  if (manifest.ui) {
    if (manifest.ui.slots) {
      const slotIds = manifest.ui.slots.map((s) => s.id);
      const duplicates = slotIds.filter((id, i) => slotIds.indexOf(id) !== i);
      if (duplicates.length > 0) {
        ctx.addIssue({
          code: z9.ZodIssueCode.custom,
          message: `Duplicate UI slot ids: ${[...new Set(duplicates)].join(", ")}`,
          path: ["ui", "slots"]
        });
      }
    }
  }
  const allLaunchers = [
    ...manifest.launchers ?? [],
    ...manifest.ui?.launchers ?? []
  ];
  if (allLaunchers.length > 0) {
    const launcherIds = allLaunchers.map((launcher) => launcher.id);
    const duplicates = launcherIds.filter((id, i) => launcherIds.indexOf(id) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: `Duplicate launcher ids: ${[...new Set(duplicates)].join(", ")}`,
        path: manifest.ui?.launchers ? ["ui", "launchers"] : ["launchers"]
      });
    }
  }
});
var installPluginSchema = z9.object({
  packageName: z9.string().min(1),
  version: z9.string().min(1).optional(),
  /** Set by loader for local-path installs so the worker can be resolved. */
  packagePath: z9.string().min(1).optional()
});
var upsertPluginConfigSchema = z9.object({
  companyId: z9.string().guid(),
  configJson: z9.record(z9.string(), z9.unknown())
});
var patchPluginConfigSchema = z9.object({
  companyId: z9.string().guid(),
  configJson: z9.record(z9.string(), z9.unknown())
});
var updatePluginStatusSchema = z9.object({
  status: z9.enum(PLUGIN_STATUSES),
  lastError: z9.string().nullable().optional()
});
var uninstallPluginSchema = z9.object({
  removeData: z9.boolean().optional().default(false)
});
var pluginStateScopeKeySchema = z9.object({
  scopeKind: z9.enum(PLUGIN_STATE_SCOPE_KINDS),
  scopeId: z9.string().min(1).optional(),
  namespace: z9.string().min(1).optional(),
  stateKey: z9.string().min(1)
});
var setPluginStateSchema = z9.object({
  scopeKind: z9.enum(PLUGIN_STATE_SCOPE_KINDS),
  scopeId: z9.string().min(1).optional(),
  namespace: z9.string().min(1).optional(),
  stateKey: z9.string().min(1),
  /** JSON-serializable value to store. */
  value: z9.unknown()
});
var listPluginStateSchema = z9.object({
  scopeKind: z9.enum(PLUGIN_STATE_SCOPE_KINDS).optional(),
  scopeId: z9.string().min(1).optional(),
  namespace: z9.string().min(1).optional()
});
export {
  pluginManifestV1Schema
};
