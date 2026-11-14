# ADR-0022：Planner 采用 LLM 结构化计划；Todo 采用 status + position + depends_on

- 状态：Accepted
- 日期：2026-11-10
- 关联：P1 1.4/1.5、P3 M5、ADR-0015、ADR-0012

## 背景

原设计把 Planner 描述为 HTN（`operators.yaml` + `htnExpand`），并给 `mission_todo` 设计单一 `current_step` 指针。实际实现已经演进为：

- Planner 用 LLM 读 mission snapshot，输出结构化 plan actions；
- `validatePlan`/事务 apply/指纹去重/最大开放任务数约束；
- Todo 是 `mission_todo` 多行，带 `status`/`position`；任务通过 `tasks.depends_on` 表达依赖；
- Scheduler/readiness 根据依赖和任务状态推进，不依赖单一 current cursor。

用户 2026-11-10 明确确认：**以当前 LLM Planner 为准；以 status + position + depends_on 为准。**

## 决策

### 1. LLM Planner 是唯一计划器

- 计划输入：mission/tasks/findings/assets/todo/frontier/checkpoint 的有界 snapshot；
- 计划输出：结构化 plan actions（create_task / update_todo / add_todo / add_hint / cancel_task / update_checkpoint）；
- 所有计划经 `validatePlan`、mission scope、open-task 上限、指纹去重、CAS 事务校验后落库；
- **不实现 HTN `operators.yaml` 作为执行路径**。原 HTN 章节保留为历史设计，不删除 ADR/历史文档，但不得再被当作当前行为描述。

### 2. Todo 的 canonical 状态是 status + position + depends_on

- `mission_todo` 是**多行**表：`id / mission_id / content / status / position / task_id / created_at / updated_at`；
- 串行与并行都由 `tasks.depends_on` + readiness 决定，不由 `current_step` 指针决定；
- `position` 只决定展示/阅读顺序，不是调度锁；
- 若 UI/Planner 需要“当前焦点”，由 API**只读派生** `currentStep`/`currentTodo`，不新增可变的数据库 current_step 列。

### 3. 为什么不是原设计

- HTN 适合固定、重复、可枚举的打法链；当前目标是开放式 SRC，未知分支多；
- 在 P4 案例库尚未建立时先手写 operators 会把灵活性换成高维护成本；
- 单 current_step 与 3 Worker、多任务、`depends_on`、cancel/retry 冲突；
- 当前 LLM Planner + 强校验 + 指纹/上限/依赖已经满足单项目自主闭环。

### 4. 未来例外

P4 案例成熟后，可以从真实 case 蒸馏出**任务模板/operator 候选**，但必须：

- 仍受 `validatePlan` 和任务依赖校验；
- 不绕过 scope/权限；
- 有 eval 回放和人工审核；
- 由新 ADR 决定是否引入 HTN 执行路径。

## 后果

- 文档、计划、架构统一按 LLM Planner 和 status/position/depends_on 描述；
- 不再把“HTN 未实现”当作待开发项；这是有意决策，不是缺失；
- 不新增 `current_step` 迁移；需要焦点时用派生 API；
- 计划质量风险由 validator、fingerprint、max open、Planner snapshot、eval/replay 和人工控制共同承担。
