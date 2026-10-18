---
title: Models
description: The Models page lists every model generation, Explore and chat can use, the server's, each workspace's and your own, and is where they are added, tested and set as a workspace's default.
---

The **Models** page lists every model generation, Explore and chat can use
([#441](https://github.com/jbouder/holotable/issues/441)). Open it from
**Models** in the main navigation. It is there for anyone who may generate in
some workspace, and in [demo mode](/admin/demo-mode/), where it lists the
server's models only.

The page has three sections, and a fourth where the server looks for a model
on this machine.

## Server

The models the operator declared, in
[`AI_MODELS_FILE`](/admin/models/#server-models-ai_models_file) or the
`AI_*` variables. Each row has its name, provider, model id and where its
credentials come from, such as "From ANTHROPIC_API_KEY". A model whose
variable is not set says which one. The server's default is marked. The
section is read-only: an operator changes it by editing the file and
restarting.

## Detected on this machine

Where the server looks for a model running beside it (by default in [local
mode](/admin/demo-mode/#a-model-on-your-machine)), this section lists what the
last scan found: Ollama, LM Studio, or anything else answering the OpenAI-style
model list at the endpoints the operator listed. Each model is named
`local:<host>:<port>/<model>`, needs no key, and can be used wherever a server
model can. The section says when it last scanned and which endpoints answered,
by host, with how many models each.

**Re-scan** asks every endpoint again, for someone who manages a workspace:
start Ollama, pull a model, then choose it. When nothing was found in local
mode, the section says just that. When exactly one endpoint answered and the
server has no model of its own, its first model is the default (marked); when
more than one did, none is, and you pick one in the [model
chip](#picking-a-model), which is remembered for the workspace.

## Each workspace

One section per workspace you generate in, with its own models and which one
a generation there uses when nobody picks.

A **source-admin** of the workspace can:

- **Add model**: give it a name, choose a provider, and fill in what that
  provider asks for. See [the provider kinds](/admin/models/#models-configured-in-the-app).
- **List models**, in the dialog once the key is in: ask the provider which
  models the key may use. Clicking or typing in the Model field then shows
  them, narrowed by what you type (an id or a display name); pick one, or
  keep typing any id. Azure deployments and Bedrock models are typed by hand.
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

## Picking a model

Every place that asks the model something has a **model chip** beside the
source chip ([#442](https://github.com/jbouder/holotable/issues/442)): a new
dashboard and its follow-ups, the panel editor's "Describe a change", the
source drafter on Data sources, Explore, and the dashboard chat. It shows the
model the next request will use. Its menu lists the models you may use in
that workspace under Server, Workspace and Yours; one that cannot be called
is greyed out with the reason. **Manage models…** opens this page.

- **Your pick is remembered** per workspace, on every device: the next new
  dashboard or conversation there starts on the model you used last.
- **A conversation keeps its model.** An Explore conversation, or a
  dashboard's chat, uses the model it was asked with for every later turn
  and after a reload, until you change the chip. If that model is deleted,
  the next turn uses your default instead.
- Without a pick, a request uses your last pick in that workspace if you
  can still use it, else your first personal model where personal models are
  allowed, else the workspace's default, else the server's.

Each generation's audit row names the model it used.

## Credentials

A key is encrypted at rest and never shown again. The page says only whether
one is stored and its last four characters. Leaving a key field blank when
editing keeps the stored key, and "Remove the stored key" clears it.
Changing where requests go, such as another provider, another base URL host,
an Azure resource or an AWS region, asks for the key again. The full rules
are in [Credentials](/admin/models/#credentials).

Settings → Workspace model and Settings → Personal model, from before this
page, now open it.
