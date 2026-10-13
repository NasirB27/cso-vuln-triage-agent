# Traffic is allowed only along the arrows in the architecture diagram:
#   allowed CIDRs -> ALB -> frontend -> backend -> database
#   ingestion/migration tasks (backend SG) -> database

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "Load balancer: ingress only from allowed CIDRs"
  vpc_id      = aws_vpc.this.id

  lifecycle { create_before_destroy = true }
  tags = { Name = "${var.name}-alb" }
}

resource "aws_security_group" "frontend" {
  name_prefix = "${var.name}-frontend-"
  description = "Next.js frontend tasks"
  vpc_id      = aws_vpc.this.id

  lifecycle { create_before_destroy = true }
  tags = { Name = "${var.name}-frontend" }
}

resource "aws_security_group" "backend" {
  name_prefix = "${var.name}-backend-"
  description = "LangGraph backend, migration and ingestion tasks"
  vpc_id      = aws_vpc.this.id

  lifecycle { create_before_destroy = true }
  tags = { Name = "${var.name}-backend" }
}

resource "aws_security_group" "db" {
  name_prefix = "${var.name}-db-"
  description = "RDS PostgreSQL"
  vpc_id      = aws_vpc.this.id

  lifecycle { create_before_destroy = true }
  tags = { Name = "${var.name}-db" }
}

# --- ALB ingress ---------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each          = toset(var.allowed_ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from allowed CIDR"
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each          = var.acm_certificate_arn == null ? toset([]) : toset(var.allowed_ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from allowed CIDR"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_frontend" {
  security_group_id            = aws_security_group.alb.id
  description                  = "ALB to frontend tasks"
  referenced_security_group_id = aws_security_group.frontend.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

# --- frontend ------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "frontend_from_alb" {
  security_group_id            = aws_security_group.frontend.id
  description                  = "From the load balancer"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "frontend_to_backend" {
  security_group_id            = aws_security_group.frontend.id
  description                  = "Frontend to LangGraph API"
  referenced_security_group_id = aws_security_group.backend.id
  from_port                    = 2024
  to_port                      = 2024
  ip_protocol                  = "tcp"
}

# Image pulls, logs and secrets go over the NAT / endpoints on 443.
resource "aws_vpc_security_group_egress_rule" "frontend_https" {
  security_group_id = aws_security_group.frontend.id
  description       = "HTTPS out (ECR, CloudWatch, Secrets Manager)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# --- backend -------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "backend_from_frontend" {
  security_group_id            = aws_security_group.backend.id
  description                  = "LangGraph API from the frontend"
  referenced_security_group_id = aws_security_group.frontend.id
  from_port                    = 2024
  to_port                      = 2024
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "backend_https" {
  security_group_id = aws_security_group.backend.id
  description       = "HTTPS out (OpenAI, ECR, CloudWatch, Secrets Manager, S3)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "backend_to_db" {
  security_group_id            = aws_security_group.backend.id
  description                  = "PostgreSQL"
  referenced_security_group_id = aws_security_group.db.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# --- database ------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "db_from_backend" {
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from backend, migration and ingestion tasks"
  referenced_security_group_id = aws_security_group.backend.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
