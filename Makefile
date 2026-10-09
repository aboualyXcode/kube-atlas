# Common tasks: `make help` lists them. Everything except the labs needs only Node 20+.
LAB ?=
KIND_CLUSTER ?= atlas

.PHONY: help serve test check docs build browser kind-up kind-down labs lab lab-clean metrics-server snapshot

help: ## list the targets
	@grep -E '^[a-z-]+:.*## ' Makefile | sed 's/:.*## /\t/'

serve: ## serve the atlas on http://localhost:8000 (opening index.html works too)
	python3 -m http.server 8000

test: ## unit tests: data integrity, matcher, layout, generated files, Markdown safety
	npm test

check: ## the data is valid and generated files are current (CI runs this)
	npm run check

docs: ## regenerate docs/ from the data
	node scripts/atlas.mjs docs

build: ## write dist/kube-atlas.html, one file that works offline
	node scripts/atlas.mjs build

browser: ## render every view in Chromium (needs: npm install --no-save playwright)
	npm run test:browser

kind-up: ## create the lab cluster: 1 control plane, 3 workers with zones, worker3 tainted for batch
	kind create cluster --config labs/kind-cluster.yaml
	kubectl label node $(KIND_CLUSTER)-worker topology.kubernetes.io/zone=lab-a --overwrite
	kubectl label node $(KIND_CLUSTER)-worker2 topology.kubernetes.io/zone=lab-b --overwrite
	kubectl label node $(KIND_CLUSTER)-worker3 topology.kubernetes.io/zone=lab-c larder.example/pool=batch --overwrite
	kubectl taint node $(KIND_CLUSTER)-worker3 dedicated=batch:NoSchedule --overwrite

kind-down: ## delete the lab cluster
	kind delete cluster --name $(KIND_CLUSTER)

labs: ## list the labs
	@ls labs/*.yaml | grep -v kind-cluster | xargs -n1 basename | sed 's/\.yaml$$//'

lab: ## apply a lab: make lab LAB=oomkilled
	@test -n "$(LAB)" || (echo "usage: make lab LAB=<name>   (make labs lists them)"; exit 2)
	kubectl apply -f labs/$(LAB).yaml
	@sed -n '/^# Observe:/,/^# Fix:/p' labs/$(LAB).yaml

lab-clean: ## remove a lab: make lab-clean LAB=oomkilled
	@test -n "$(LAB)" || (echo "usage: make lab-clean LAB=<name>"; exit 2)
	kubectl delete -f labs/$(LAB).yaml --ignore-not-found --wait=false

metrics-server: ## install metrics-server into the kind cluster (the HPA lab needs it)
	kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
	kubectl patch deployment metrics-server -n kube-system --type=json \
	  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

snapshot: ## a read-only snapshot of the current cluster for an incident channel
	tools/snapshot.sh
