# Data tier: RDS PostgreSQL (pgvector), the S3 scan-drop bucket, ECR repos,
# and Secrets Manager entries.

# --- Database ------------------------------------------------------------

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db"
  subnet_ids = aws_subnet.data[*].id
}

resource "aws_db_instance" "this" {
  identifier     = "${var.name}-pg"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "cso"
  username = "cso_admin"
  # RDS creates and rotates the master password in Secrets Manager; it never
  # appears in Terraform state or variables.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period    = 7
  auto_minor_version_upgrade = true
  deletion_protection        = var.db_deletion_protection
  skip_final_snapshot        = var.db_skip_final_snapshot
  final_snapshot_identifier  = var.db_skip_final_snapshot ? null : "${var.name}-pg-final"

  lifecycle {
    # engine_version "16" floats to the current minor; don't plan a diff for it.
    ignore_changes = [engine_version]
  }
}

# --- Scan drop bucket ----------------------------------------------------

resource "aws_s3_bucket" "scans" {
  bucket_prefix = "${var.name}-scans-"
}

resource "aws_s3_bucket_versioning" "scans" {
  bucket = aws_s3_bucket.scans.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "scans" {
  bucket = aws_s3_bucket.scans.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "scans" {
  bucket                  = aws_s3_bucket.scans.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "scans_tls_only" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.scans.arn, "${aws_s3_bucket.scans.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "scans" {
  bucket     = aws_s3_bucket.scans.id
  policy     = data.aws_iam_policy_document.scans_tls_only.json
  depends_on = [aws_s3_bucket_public_access_block.scans]
}

# --- Container registries ------------------------------------------------

resource "aws_ecr_repository" "backend" {
  name                 = "${var.name}-backend"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "frontend" {
  name                 = "${var.name}-frontend"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# --- Secrets -------------------------------------------------------------

resource "aws_secretsmanager_secret" "openai" {
  name_prefix = "${var.name}/openai-api-key-"
}

resource "aws_secretsmanager_secret_version" "openai" {
  secret_id     = aws_secretsmanager_secret.openai.id
  secret_string = var.openai_api_key
}

resource "aws_secretsmanager_secret" "langchain" {
  name_prefix = "${var.name}/langchain-api-key-"
}

resource "aws_secretsmanager_secret_version" "langchain" {
  secret_id     = aws_secretsmanager_secret.langchain.id
  secret_string = var.langchain_api_key
}
