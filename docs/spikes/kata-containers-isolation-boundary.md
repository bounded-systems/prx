# Kata Containers — VM-grade isolation with container ergonomics, mapped to prx (spike)

> Design-only spike. Reads **Kata Containers** (Open Infrastructure Foundation,
> Apache-2.0) as a **general systems pattern** — *move the trust boundary down a
> layer without changing the interface above it* — and tests it against prx's
> capability/authority-boundary architecture. No `src/`/`packages/` changes in
> this unit — the **mapping and the one transferable lesson are the deliverable**.
> Written 2026-06-13. Companion to `two-clock-policy.md` and
> `capability-orchestrator.md`.

## 0. Status

**Exploratory — no decision forced.** Finding: Kata and prx are the *same move*
applied to two different substrates. Kata converts `container = namespace
boundary` (a *convention* the shared kernel is trusted to honor) into `container
= VM boundary` (a *structural* boundary the hardware enforces) — **without
changing the interface** Podman/Kubernetes sees. prx makes the identical move on
agent effects: it converts `effect = ambient Bash call` (a convention the
orchestrator is trusted to honor) into `effect = signed owning-actor derivation`
(a structural boundary the verify gate enforces) — without changing the verb
surface the operator sees. The transferable framing (§5): **an isolation
hierarchy is a cost ladder, and you climb it only as far as the threat model
pays for.** This spike records the mapping; it forces no build.

## 1. The pattern, stripped of containers

A normal container is one kernel shared by every workload, partitioned by
namespaces and cgroups:

```
Container A   Container B   Container C
        \         |         /
         host Linux kernel          ← one shared authority
```

The boundary between A and B is a *kernel-enforced convention*: a namespace is
only as strong as the kernel's promise not to leak across it. A kernel escape
from A reaches B and C, because there is one kernel to escape.

Kata keeps the **interface** (`podman run nginx`, a k8s Pod) and swaps the
**substrate** underneath it — each container gets its own lightweight VM and
guest kernel:

```
podman run nginx
  → Podman
  → Kata runtime          ← not a hypervisor; it orchestrates one
  → Firecracker / Cloud Hypervisor / QEMU
  → microVM
  → Linux guest kernel
  → nginx
```

Kata is **not** the hypervisor — it makes a hypervisor *behave like a container
runtime*. The container still looks like an ordinary container to the layer
above; underneath, the boundary moved from "namespace in a shared kernel" to
"hardware-virtualized VM with its own kernel." A kernel escape in A's guest now
hits a hardware VM boundary before it can reach B.

| Runtime | Boundary | Startup | Resource cost |
|---|---|---|---|
| `runc` / `crun` | shared kernel (namespaces) | very fast | lowest |
| gVisor | userspace syscall sandbox | fast | low |
| **Kata** | **hardware VM** | fast-ish | higher |
| traditional VM | full VM | slowest | highest |

The reason cloud providers reach for it is **multi-tenancy**: with ordinary
containers every customer shares one kernel; with Kata `Customer A → VM A`,
`Customer B → VM B`, so a kernel escape from one tenant does not immediately
reach the others. Hardware virtualization becomes a *second* security boundary
behind the namespace one.

The analogy that travels: a Docker container is an apartment in one building
(shared structure, thin walls); a Kata container is a tiny detached house (its
own walls, own foundation); a full VM is a full-sized house. "VM security with
container ergonomics" is the detached-house line.

## 2. Why this is a prx-shaped pattern

The move has a precise shape, and prx already made it once:

> **Take a boundary that is enforced by a *shared, trusted* component, and
> re-seat it on a boundary that is enforced *structurally* — while leaving the
> interface above it unchanged.**

| | **Kata** | **prx** |
|---|---|---|
| Interface kept stable | `podman run` / k8s Pod | the `prx <verb>` / actor surface |
| Weak (convention) boundary | namespace in a shared kernel | effect run from ambient Bash by the orchestrator |
| Strong (structural) boundary | per-workload hardware VM + guest kernel | per-effect signed owning-actor derivation |
| What enforces it | the CPU's virtualization extensions | the verify gate over the delegation DAG |
| Shared authority removed | the one host kernel | ambient authority (unrestricted `Bash`) |

`docs/capability-orchestrator.md` defines *ambient authority* as "a privileged
effect performed by a principal that holds the capability merely by virtue of
its execution environment … rather than by holding a narrow, delegated
capability." That is **exactly** the shared-kernel problem in a different
substrate: the orchestrator's ambient `Bash` is prx's "one host kernel" —
everything runs through it, and a boundary that exists only as a *convention*
("the orchestrator shouldn't `git push`") is one mistake away from a cross-tenant
leak. prx's fix is Kata's fix: don't trust the shared component to honor the
boundary; make the boundary structural. An effect with no matching owning-actor
input derivation is an "orphan/ambient effect" and the gate **fails closed** on
it (`provenance/effect-ownership.ts`) — the cryptographic analogue of "this
syscall never leaves the guest VM."

The isolation, too, rhymes. Kata gives each workload an **ephemeral microVM** GC'd
when the workload exits; prx gives each actor an **ephemeral salted worktree on a
salted branch**, removed on finish (`pipeline/ephemeral-worktree.ts`,
`withEphemeralActorWorktree`). In both, *the durable artifact is the output, not
the sandbox* — for Kata the container's result, for prx "the only durable state
is the signed CAS artifact the actor hands off." Two tenants never share a
kernel; two actors never share a worktree or branch checkout.

## 3. The nested case — Lima, and when a second boundary stops paying

A second message in this thread raised running Kata *inside* a Lima VM on macOS:

```
macOS → Apple Virtualization.framework / QEMU → Lima VM → Linux
```

and, with Kata stacked in:

```
macOS → Lima VM → Kata → microVM → container
```

— **nested virtualization**, a VM inside a VM. Whether it works depends on the
hypervisor and whether the extensions are exposed to the Linux guest; inside Lima
on macOS the guest usually does not get bare-metal access to virtualization
extensions, so Kata-in-Lima is *possible in some configurations but not the
typical setup*. The common, well-supported local stacks are
`macOS → Lima → Podman → crun` or `macOS → Lima → gVisor → container` — Kata's
primary target is a real Linux host.

A rough isolation ladder (`<` = "generally weaker than"):

```
container (crun/runc)  <  gVisor  <  Lima VM  <  Lima VM + Kata
```

The decisive observation: **the biggest jump is container → VM.** Once a workload
is already inside a dedicated Linux VM (Lima), it is *already* behind a strong
boundary; adding Kata inside that VM is a second VM boundary with **diminishing
returns** unless you are specifically testing cloud-style multi-tenant isolation
or container-escape defenses.

This is the part prx should internalize directly, because prx is *also* a stack
of nested boundaries:

```
policy allowlist  <  PreToolUse policy hook  <  ephemeral salted worktree  <  signed delegation DAG
   (authored)         (runtime, fail-closed)     (structural isolation)        (auditable provenance)
```

`capability-orchestrator.md` already sequences these by *what class of violation
each one closes* — the hook makes an out-of-allowlist effect "denied at runtime"
(T2), while the salted worktree makes the prx-5l3 branch-collision class
"structurally impossible." That is the same ladder logic as Kata-vs-Lima: **each
added boundary should close a violation class the cheaper one below it cannot**,
or it is paying VM-startup cost for apartment-grade threat. The doc's own
sequencing rationale ("C1 is the cheapest demonstrable slice … C4/C5 make
violations structurally impossible") is exactly the "climb the ladder only as far
as the threat model pays for" discipline, stated for prx's substrate.

## 4. Where the analogy breaks (and why that's the interesting part)

The mapping is tight, but two seams differ, and each is informative:

- **Kata's boundary is opaque; prx's is legible.** A hardware VM boundary is a
  black wall — A simply cannot see B. prx's boundary is *auditable*: a violation
  isn't merely blocked, it leaves (or fails to leave) a signed derivation on the
  chain. prx buys not just isolation but an **after-the-fact provenance record**
  of who was authorized to cause each effect — something a hypervisor does not
  give you for free. The cost is the inverse: prx must *attest*, where Kata only
  has to *prevent*.
- **Kata pays at runtime; prx pays mostly at verify time.** Kata's cost is real
  resources (a VM per workload, every workload, forever). prx's strong boundary
  is the verify gate + signing — cheap per call, concentrated at the merge/handoff
  seam. This is why prx can afford to keep *all* the layers in §3 where a
  multi-tenant cloud must ration VMs: prx's "VM per tenant" is a signature, not a
  kernel.

The shared lesson survives the break: **moving a boundary down a layer is only
worth it when the layer above keeps the same interface** — Kata would be useless
if `podman run` had to change, and prx's capability seams would be useless if
operators had to learn a new verb surface to get the stronger boundary. The
ergonomics are the whole point; the isolation is free to the caller precisely
because the *interface* didn't move when the *boundary* did.

## 5. The transferable lesson, for prx specifically

1. **Name the ladder, and the jump.** Kata's value is legible because the
   isolation hierarchy is explicit and the container→VM jump is named as the big
   one. prx's `capability-orchestrator.md` has the ladder (allowlist → hook →
   ephemeral worktree → signed DAG) but does not yet name *which jump is the big
   one* for a given threat. Stating it — "ambient-Bash → policy hook is prx's
   container→VM jump; everything above it is the second VM boundary" — guides
   where to spend next.
2. **Don't stack a second strong boundary where the first already pays.** The
   Kata-in-Lima diminishing-returns result is a direct caution against prx
   over-attesting: if the ephemeral salted worktree already makes a violation
   class *structurally impossible*, adding a signed-DAG check for that **same**
   class is the second VM inside Lima — cost without a new closed violation. Spend
   the strong boundary where it closes something the layer below can't.
3. **Interface stability is the enabling constraint, not a nicety.** Kata's
   "container ergonomics" and prx's "same verb surface" are the same design law:
   the stronger boundary only ships if the caller doesn't have to change. Any prx
   change that strengthens a boundary *and* perturbs the actor/verb surface should
   be treated as suspect by this analogy — it has given up the thing that makes
   the move adoptable.

## 6. Non-goals & open questions

- **Non-goal:** running Kata anywhere in prx's own toolchain, or proposing VM
  isolation for prx actors. The microVM is the *metaphor* for prx's structural
  boundary; prx's actual boundary is cryptographic (signed derivations) and
  filesystem (ephemeral worktrees), and that is the right substrate for it.
- **Open:** is there a prx threat class that genuinely wants a *process/VM*
  boundary and not just a signed-provenance one — e.g. an actor executing
  untrusted code from a work unit, where a kernel/VM escape is in scope? That is
  the one case where Kata stops being only an analogy. (Likely out of scope for
  the integrity/auditability model `capability-orchestrator.md` §1 sets, which
  explicitly is "not a sandbox/escape defense against a malicious local
  operator.")
- **Open:** can the §3 ladder be made *as legible as Kata's table* — a generated
  artifact that, per violation class, names the cheapest boundary that closes it?
  The capability features in `features/` are the natural home for it.
- **Tension:** prx's boundary being legible (signed, on-chain) is a strength over
  Kata's opaque wall, but legibility is also surface. The provenance record that
  proves authorization is itself something to protect — the analogue of not
  leaking the hypervisor's own state to the guest.
