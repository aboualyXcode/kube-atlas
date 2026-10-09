# Contributing

Everything the atlas draws comes from the files in `data/`. Edit the data, then run:

```sh
npm test          # unit tests
npm run check     # validation, and generated files are current
npm run docs      # regenerate docs/ and commit the result
```

`npm run check` explains every problem it finds: an unknown id, a station that is not on the map, a sample that matches the wrong entry, two stations that overlap.

## Add a failure

Add an entry to the file in `data/failures/` for its layer. Multi-line text is an array of lines in Markdown.

```js
{
  id: "my-failure",                 // kebab-case, unique
  title: "What people search for",
  kind: "cause",                    // "cause" names a mechanism; "symptom" tells you where to look
  layer: "networking",              // one of the layers in data/taxonomy.js
  scope: "eks",                     // "any" Kubernetes cluster, or "eks"
  summary: "One sentence: what goes wrong and why.",
  propagation: {
    map: "eks",                     // the map it is drawn on: "cluster" or "eks"
    origins: [{ at: "security-groups", note: "Where it starts, in a few words" }],
    path: [{ at: "cni", note: "What each component does with it" }],
    symptom: { at: "application", note: "What you notice, and where" },
    branches: [{ from: "cni", at: "kubelet", note: "Knock-on effects (optional)" }],
  },
  components: ["cni", "security-groups"],
  symptom: ["..."], affected: ["..."], rootCause: ["..."],
  investigation: [{ title: "...", run: ["kubectl ..."], lookFor: "..." }],
  resolution: ["..."],
  prevention: ["...", "..."],
  signals: [[3, "a regular expression for a message that names the cause"]],
  samples: ["a real message, exactly as the cluster printed it"],
  related: [], lab: null, runbook: null,
}
```

Then:

- add it to at least one symptom fan in `data/triage.js`, with the tell that distinguishes it;
- make every station in `propagation` one that exists on the chosen map in `data/maps.js`;
- give it at least one real sample. Validation fails if a sample matches another entry first; sharpen the signals rather than the samples. Messages that name a cause deserve higher weights than statuses.

## Add a component

Add it to `data/components.js` (what it is, what it does, how it works inside, production notes, EKS notes, commands), then place it on a map in `data/maps.js` with its centre, width and height. Connections are drawn from `edges`; use `via` waypoints to route a connection around other stations. Validation fails if the station overlaps another or a connection runs through one.

## Add a flow or an incident

Flows (`data/flows.js`) are steps from one station to another, each with the failures that can break it. Incidents (`data/incidents.js`) are hops at stations, each with a command, its output and what it proved, ending in a causal chain. Both are checked against the map they name.

## Labs and alerts

A lab in `labs/` breaks a local kind cluster the way one entry describes; set `lab` in the entry. Alert rules live in `reference/observability/alerts.yaml`; every `runbook_url` must point at a generated page. After changing them, run `npm run alerts` to refresh `data/alerts.js`.
