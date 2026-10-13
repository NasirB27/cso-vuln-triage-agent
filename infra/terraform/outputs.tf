output "alb_dns_name" {
  description = "Public entry point (HTTP unless acm_certificate_arn is set)."
  value       = aws_lb.this.dns_name
}

output "ecr_backend_repository_url" {
  value = aws_ecr_repository.backend.repository_url
}

output "ecr_frontend_repository_url" {
  value = aws_ecr_repository.frontend.repository_url
}

output "scans_bucket" {
  description = "Upload scan JSON under the scans/ prefix."
  value       = aws_s3_bucket.scans.id
}

output "database_endpoint" {
  value = aws_db_instance.this.address
}

output "backend_private_url" {
  description = "What the frontend image must be built with as NEXT_PUBLIC_LANGGRAPH_API_URL."
  value       = local.backend_url
}

output "run_migration_command" {
  description = "One-off task that applies backend/sql to the database. Run once after the first apply."
  value = join(" ", [
    "aws ecs run-task",
    "--region ${var.region}",
    "--cluster ${aws_ecs_cluster.this.name}",
    "--launch-type FARGATE",
    "--task-definition ${aws_ecs_task_definition.migrate.family}",
    "--network-configuration 'awsvpcConfiguration={subnets=[${join(",", aws_subnet.private[*].id)}],securityGroups=[${aws_security_group.backend.id}],assignPublicIp=DISABLED}'",
  ])
}

output "run_ingestion_command" {
  description = "Run ingestion once by hand (same task the schedule runs)."
  value = join(" ", [
    "aws ecs run-task",
    "--region ${var.region}",
    "--cluster ${aws_ecs_cluster.this.name}",
    "--launch-type FARGATE",
    "--task-definition ${aws_ecs_task_definition.ingest.family}",
    "--network-configuration 'awsvpcConfiguration={subnets=[${join(",", aws_subnet.private[*].id)}],securityGroups=[${aws_security_group.backend.id}],assignPublicIp=DISABLED}'",
  ])
}
