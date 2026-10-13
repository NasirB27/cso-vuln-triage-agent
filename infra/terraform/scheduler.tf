# Scheduled ingestion: EventBridge runs the `ingest` task in the private
# subnets. Disabled until scan JSON exists in the bucket (see ingestion_enabled).

data "aws_iam_policy_document" "events_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "events" {
  name               = "${var.name}-events-run-ingest"
  assume_role_policy = data.aws_iam_policy_document.events_assume.json
}

data "aws_iam_policy_document" "events_run_ingest" {
  statement {
    actions   = ["ecs:RunTask"]
    resources = ["${aws_ecs_task_definition.ingest.arn_without_revision}:*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.backend_task.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "events_run_ingest" {
  name   = "run-ingest-task"
  role   = aws_iam_role.events.id
  policy = data.aws_iam_policy_document.events_run_ingest.json
}

resource "aws_cloudwatch_event_rule" "ingest" {
  name                = "${var.name}-ingest"
  description         = "Scheduled scan ingestion into pgvector"
  schedule_expression = var.ingestion_schedule
  state               = var.ingestion_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "ingest" {
  rule     = aws_cloudwatch_event_rule.ingest.name
  arn      = aws_ecs_cluster.this.arn
  role_arn = aws_iam_role.events.arn

  ecs_target {
    launch_type         = "FARGATE"
    task_count          = 1
    task_definition_arn = aws_ecs_task_definition.ingest.arn

    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.backend.id]
      assign_public_ip = false
    }
  }
}
