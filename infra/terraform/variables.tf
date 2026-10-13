variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Name prefix for all resources."
  type        = string
  default     = "cso-triage"
}

variable "vpc_cidr" {
  description = "CIDR for the VPC. Subnets are carved out of it (public /24s, private app /24s, private data /24s)."
  type        = string
  default     = "10.0.0.0/16"
}

variable "single_nat_gateway" {
  description = "One shared NAT gateway (cheaper) instead of one per AZ (resilient to an AZ outage)."
  type        = bool
  default     = true
}

variable "allowed_ingress_cidrs" {
  description = "CIDR blocks allowed to reach the load balancer. Required on purpose: there is no open-to-the-world default."
  type        = list(string)

  validation {
    condition     = length(var.allowed_ingress_cidrs) > 0 && !contains(var.allowed_ingress_cidrs, "0.0.0.0/0")
    error_message = "Provide at least one CIDR and do not use 0.0.0.0/0 (this app has no authentication layer)."
  }
}

variable "acm_certificate_arn" {
  description = "ACM certificate for HTTPS on the load balancer. If null, the ALB serves plain HTTP only (not for anything beyond a short-lived demo)."
  type        = string
  default     = null
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture. Must match how the images were built (use --platform linux/amd64 on Apple Silicon for X86_64)."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "backend_image" {
  description = "Full image reference for the backend, e.g. <account>.dkr.ecr.<region>.amazonaws.com/cso-triage-backend:1.0.0"
  type        = string
}

variable "frontend_image" {
  description = "Full image reference for the frontend. Its NEXT_PUBLIC_LANGGRAPH_API_URL build arg must equal http://backend.<private_namespace>:2024"
  type        = string
}

variable "private_namespace" {
  description = "Cloud Map private DNS namespace; the backend is reachable at backend.<namespace>."
  type        = string
  default     = "cso.internal"
}

variable "openai_api_key" {
  description = "OpenAI API key (stored in Secrets Manager)."
  type        = string
  sensitive   = true
}

variable "langchain_api_key" {
  description = "LangSmith API key. The frontend client requires a non-empty value; the dev server does not validate it."
  type        = string
  sensitive   = true
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_multi_az" {
  description = "Run the database Multi-AZ."
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "Block accidental deletion of the database."
  type        = bool
  default     = true
}

variable "db_skip_final_snapshot" {
  description = "Skip the final snapshot on destroy. Leave false unless the data is disposable."
  type        = bool
  default     = false
}

variable "ingestion_schedule" {
  description = "EventBridge schedule expression for the ingestion task."
  type        = string
  default     = "cron(0 6 * * ? *)"
}

variable "ingestion_enabled" {
  description = "Enable the scheduled ingestion task. Leave off until scan JSON has been uploaded to the scans bucket."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}
