---
title: Models
description: The Models page lists every model generation, Explore and chat can use, the server's, each workspace's and your own, and is where they are added, tested and set as a workspace's default.
---

The **Models** page lists every model generation, Explore and chat can use
([#441](https://github.com/jbouder/holotable/issues/441)). Open it from
**Models** in the main navigation. It is there for anyone who may generate in
some workspace, and in [demo mode](/admin/demo-mode/), where it lists the
server's models only.

The page has three sections.

## Server

The models the operator declared, in
[`AI_MODELS_FILE`](/admin/ai-provider/#server-models-ai_models_file) or the
`AI_*` variables. Each row has its name, provider, model id and where its
credentials come from, such as "From ANTHROPIC_API_KEY". A model whose
variable is not set says which one. The server's default is marked. The
section is read-only: an operator changes it by editing the file and
restarting.

## Each workspace

One section per workspace you generate in, with its own models and which one
a generation there uses when nobody picks.

A **source-admin** of the workspace can:

- **Add model**: give it a name, choose a provider, and fill in what that
  provider asks for. See [the provider kinds](/admin/ai-provider/#models-configured-in-the-app).
- **Test**: make one small model call, so a wrong model id or key is found now
  rather than on someone's next generation. The call counts against the
  workspace's [limits](/admin/llm-limits/).
- **Edit** a model's name or settings.
- **Set as default**, or **Use the server's default**.
- **Delete** a model, after confirming. Deleting the default goes back to the
  server's.
- Turn **Let people use their own models here** on or off.

Everyone else sees the workspace's models and its default, and cannot change
them.

## Yours

Your own models, billed to you, with **Add model**, **Edit**, **Test** and
**Delete**. They can be used only in workspaces whose source-admins allow
personal models; the section says which those are. Elsewhere they are kept
and ignored.

## Credentials

A key is encrypted at rest and never shown again. The page says only whether
one is stored and its last four characters. Leaving a key field blank when
editing keeps the stored key, and "Remove the stored key" clears it.
Changing where requests go, such as another provider, another base URL host,
an Azure resource or an AWS region, asks for the key again. The full rules
are in [Credentials](/admin/ai-provider/#credentials).

Settings → Workspace model and Settings → Personal model, from before this
page, now open it.
