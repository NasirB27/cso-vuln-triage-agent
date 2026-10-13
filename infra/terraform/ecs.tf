# Compute tier: ECS Fargate in the private subnets.
#   frontend  -> behind the ALB (port 3000)
#   backend   -> LangGraph API, reachable only from the frontend (port 2024),
#                discovered at backend.<private_namespace> via Cloud Map
#   migrate   -> one-off task: applies backend/sql to the database
#   ingest    -> scheduled task: scan JSON in S3 -> embeddings -> pgvector

locals {
  backend_url = "http://backend.${var.private_namespace}:2024"
  rds_secret  = aws_db_instance.this.master_user_secret[0].secret_arn

  # Shared by every backend-image task (service, migration, ingestion).
  db_environment = [
    { name = "RETRIEVER_PROVIDER", value = "pgvector" },
    { name = "PGHOST", value = aws_db_instance.this.address },
    { name = "PGPORT", value = tostring(aws_db_instance.this.port) },
    { name = "PGDATABASE", value = aws_db_instance.this.db_name },
  ]

  # Injected by ECS from Secrets Manager at task start; never in the image or
  # in the task definition's plain-text environment.
  db_secrets = [
    { name = "PGUSER", valueFrom = "${local.rds_secret}:username::" },
    { name = "PGPASSWORD", valueFrom = "${local.rds_secret}:password::" },
    { name = "OPENAI_API_KEY", valueFrom = aws_secretsmanager_secret.openai.arn },
  ]

  node_http_check = "node -e \"fetch('%s').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(["frontend", "backend", "migrate", "ingest"])
  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
}

# --- IAM -----------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: what ECS itself needs to start a task (pull image, write
# logs, read the three secrets referenced above).
resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.openai.arn,
      aws_secretsmanager_secret.langchain.arn,
      local.rds_secret,
    ]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-app-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# Task role: what the backend-image code can do at runtime. Only read access to
# the scan-drop bucket; no database IAM, no write access anywhere.
resource "aws_iam_role" "backend_task" {
  name               = "${var.name}-backend-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "backend_task" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.scans.arn]
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.scans.arn}/*"]
  }
}

resource "aws_iam_role_policy" "backend_task" {
  name   = "read-scan-drop"
  role   = aws_iam_role.backend_task.id
  policy = data.aws_iam_policy_document.backend_task.json
}

# --- Service discovery ---------------------------------------------------

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = var.private_namespace
  vpc  = aws_vpc.this.id
}

resource "aws_service_discovery_service" "backend" {
  name = "backend"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"

    dns_records {
      ttl  = 10
      type = "A"
    }
  }
}

# --- Task definitions ----------------------------------------------------

resource "aws_ecs_task_definition" "backend" {
  family                   = "${var.name}-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.backend_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name         = "backend"
      image        = var.backend_image
      essential    = true
      portMappings = [{ containerPort = 2024, protocol = "tcp" }]
      environment  = local.db_environment
      secrets      = local.db_secrets
      healthCheck = {
        command     = ["CMD-SHELL", format(local.node_http_check, "http://127.0.0.1:2024/info")]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service["backend"].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "backend"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "frontend" {
  family                   = "${var.name}-frontend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name         = "frontend"
      image        = var.frontend_image
      essential    = true
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      environment = [
        { name = "NEXT_PUBLIC_LANGGRAPH_API_URL", value = local.backend_url },
        { name = "LANGGRAPH_INGESTION_ASSISTANT_ID", value = "ingestion_graph" },
        { name = "LANGGRAPH_RETRIEVAL_ASSISTANT_ID", value = "retrieval_graph" },
      ]
      secrets = [
        { name = "LANGCHAIN_API_KEY", valueFrom = aws_secretsmanager_secret.langchain.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service["frontend"].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "frontend"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.backend_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name        = "migrate"
      image       = var.backend_image
      essential   = true
      command     = ["yarn", "migrate:pgvector"]
      environment = local.db_environment
      secrets     = local.db_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service["migrate"].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "migrate"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "ingest" {
  family                   = "${var.name}-ingest"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.backend_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = "ingest"
      image     = var.backend_image
      essential = true
      command   = ["yarn", "ingest:run"]
      environment = concat(local.db_environment, [
        { name = "SCANS_S3_BUCKET", value = aws_s3_bucket.scans.id },
        { name = "SCANS_S3_PREFIX", value = "scans/" },
      ])
      secrets = local.db_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service["ingest"].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "ingest"
        }
      }
    }
  ])
}

# --- Services ------------------------------------------------------------

# One replica on purpose: the LangGraph dev server keeps thread state in
# memory, so a second replica would not share it.
resource "aws_ecs_service" "backend" {
  name            = "backend"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.backend.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.backend.arn
  }
}

resource "aws_ecs_service" "frontend" {
  name                              = "frontend"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.frontend.arn
  desired_count                     = 1
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.frontend.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "frontend"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.http]
}
