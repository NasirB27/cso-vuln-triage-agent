# AWS deployment (Option A: lift-and-shift)

Terraform for running this repo on AWS with the same shape as the Lucid AWS
network template: VPC, two AZs, public and private subnets, one ingress, and
the data tier isolated from the internet.

```
allowed CIDRs ──> ALB (public subnets)
                    └─> frontend (Fargate, private)  :3000
                          └─> backend (Fargate, private)  :2024   backend.cso.internal
                                ├─> RDS PostgreSQL 16 + pgvector (data subnets)
                                └─> OpenAI API (egress via NAT)

EventBridge (schedule) ──> ingest task ──> S3 scans bucket ──> embeddings ──> RDS
one-off ──────────────────> migrate task ──> applies backend/sql/*.sql to RDS
```

| Piece | Where |
| --- | --- |
| VPC, subnets, NAT, S3 endpoint | `terraform/network.tf` |
| Security groups (only the arrows above) | `terraform/security.tf` |
| RDS, scans bucket, ECR, secrets | `terraform/data.tf` |
| Load balancer | `terraform/alb.tf` |
| ECS cluster, tasks, services, IAM, service discovery | `terraform/ecs.tf` |
| Scheduled ingestion | `terraform/scheduler.tf` |

## Deploy

Prereqs: Terraform >= 1.6, AWS credentials, Docker with buildx.

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # set allowed_ingress_cidrs and images
export TF_VAR_openai_api_key=...               # secrets via env, not the tfvars file
export TF_VAR_langchain_api_key=...

# 1. Create the image repositories first
terraform init
terraform apply -target=aws_ecr_repository.backend -target=aws_ecr_repository.frontend

# 2. Build and push (from the repo root). --platform must match cpu_architecture.
cd ../..
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker buildx build --platform linux/amd64 -f backend/Dockerfile \
  -t <backend_repo_url>:0.1.0 --push .
docker buildx build --platform linux/amd64 -f frontend/Dockerfile \
  --build-arg NEXT_PUBLIC_LANGGRAPH_API_URL=http://backend.cso.internal:2024 \
  -t <frontend_repo_url>:0.1.0 --push .

# 3. Everything else
cd infra/terraform && terraform apply

# 4. Create the schema (once), using the command Terraform prints
terraform output -raw run_migration_command | sh

# 5. Load data: upload scan JSON, ingest once, then enable the schedule
aws s3 cp ../../backend/src/sample_scans s3://$(terraform output -raw scans_bucket)/scans/ --recursive
terraform output -raw run_ingestion_command | sh
# then set ingestion_enabled = true and re-apply
```

The app is at `terraform output alb_dns_name`.

If you change `private_namespace`, rebuild the frontend with the matching
`NEXT_PUBLIC_LANGGRAPH_API_URL`; that value is inlined at build time.

## Read this before showing it to anyone

- **The backend runs the LangGraph CLI dev server.** State is in memory and
  lost on restart, there is no authentication, and the service is pinned to one
  replica. Network isolation (security groups) is the only access control. A
  production deployment needs LangGraph Platform self-hosted or your own API
  around the graphs, with real auth.
- **HTTP only unless you set `acm_certificate_arn`.** `allowed_ingress_cidrs`
  rejects `0.0.0.0/0` on purpose.
- **The frontend is still the PDF-upload chat template** and was not redesigned
  for scan data (see the root README).
- **Cost:** a NAT gateway (about $32/month plus data) and the RDS instance run
  continuously. Set `single_nat_gateway = false` for one NAT per AZ.
- **Re-embedding:** `sql/001_init_documents.sql` fixes 1536 dimensions
  (`text-embedding-3-small`). Changing the embedding model means a new column
  size and a full re-ingest.
- **Scale:** the triage tool reads every row and ranks in code. That is fine
  for the demo's ~50 images and will need a pushed-down query at thousands.

## Verification status

Validated locally: `tofu fmt -check` (syntax and formatting only), the backend
code (`yarn tsc --noEmit`) and tests (`yarn jest`, 41 passing), and the frontend
standalone build.

Validated against a local PostgreSQL 16 with pgvector 0.6.0 (Ubuntu package;
Docker was unavailable): `yarn migrate:pgvector` applies
`backend/sql/001_init_documents.sql` cleanly, producing the `vector(1536)`
column, the HNSW cosine index, the GIN index and the btree expression index.
Re-running `deleteExistingScanRows` + `addDocuments` (with a fake embedder, not
OpenAI) leaves exactly one row per `(imageName, imageTag)`.

Not validated:
- `terraform init`/`validate`/`plan`: the HashiCorp registry and binary host
  returned 403 from the build environment, so provider schema was never
  checked and `.terraform.lock.hcl` has not been generated. Run
  `terraform init && terraform validate` locally, then
  `terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64 -platform=darwin_amd64`
  and commit the lock file.
- Docker images: Docker Hub returned 403, so neither image was built or run
  (backend `/info` on 2024 and frontend `/` on 3000 remain unchecked).
- RDS: `CREATE EXTENSION vector` as the RDS master user was not run against a
  real instance. HNSW needs pgvector 0.5.0 or later; `engine_version = "16"` in
  `data.tf` floats to the current 16.x minor, but the exact pgvector version
  shipped per RDS 16.x minor was not confirmed.
