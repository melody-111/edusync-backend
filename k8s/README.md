# Kubernetes Deployment for Digital Classroom Backend

This directory contains Kubernetes manifests for deploying the Digital Classroom backend with high availability and auto-scaling.

## Prerequisites

- Kubernetes cluster (min 3 nodes for production)
- kubectl configured
- Helm installed (optional)
- NGINX Ingress Controller installed
- Cert-Manager installed (for SSL certificates)

## Architecture

- **Backend**: 3 replicas with HPA (auto-scales 3-50 pods)
- **MongoDB**: 3-node replica set for user data
- **PostgreSQL**: 1 replica for notes/classes data
- **Redis**: 1 replica with persistence for caching
- **Load Balancer**: NGINX Ingress Controller

## Deployment Steps

### 1. Create Namespace
```bash
kubectl apply -f namespace.yaml
```

### 2. Create Secrets
```bash
kubectl apply -f backend-secrets.yaml -n digital-classroom
```

### 3. Create ConfigMap
```bash
kubectl apply -f backend-configmap.yaml -n digital-classroom
```

### 4. Deploy Databases
```bash
kubectl apply -f mongodb-deployment.yaml -n digital-classroom
kubectl apply -f mongodb-service.yaml -n digital-classroom
kubectl apply -f postgres-deployment.yaml -n digital-classroom
kubectl apply -f postgres-service.yaml -n digital-classroom
kubectl apply -f redis-deployment.yaml -n digital-classroom
kubectl apply -f redis-service.yaml -n digital-classroom
```

### 5. Deploy Backend
```bash
kubectl apply -f backend-deployment.yaml -n digital-classroom
kubectl apply -f backend-service.yaml -n digital-classroom
kubectl apply -f backend-hpa.yaml -n digital-classroom
```

### 6. Deploy Ingress
```bash
kubectl apply -f backend-ingress.yaml -n digital-classroom
```

## Scaling

The backend deployment uses Horizontal Pod Autoscaler (HPA) to automatically scale based on CPU and memory usage:
- **Min Replicas**: 3
- **Max Replicas**: 50
- **CPU Target**: 70%
- **Memory Target**: 80%

## Monitoring

Health checks are configured for all services:
- **Liveness Probe**: Checks if container is running
- **Readiness Probe**: Checks if container is ready to serve traffic

## Security

- Secrets are used for sensitive data (passwords, API keys)
- Non-root user in containers
- Network policies should be added for additional security
- TLS/SSL enabled via Cert-Manager

## Storage

- **MongoDB**: 100Gi per replica
- **PostgreSQL**: 50Gi
- **Redis**: 5Gi (in-memory)

## High Traffic Configuration

The deployment is configured to handle:
- 1000 colleges
- 10 million students/teachers
- Auto-scaling up to 50 backend pods
- Redis with LRU eviction policy
- PostgreSQL with optimized connection settings
- MongoDB with replica set for high availability

## Rollback

To rollback to previous deployment:
```bash
kubectl rollout undo deployment/backend -n digital-classroom
```

## Troubleshooting

Check pod status:
```bash
kubectl get pods -n digital-classroom
kubectl logs -f deployment/backend -n digital-classroom
```

Check HPA status:
```bash
kubectl get hpa -n digital-classroom
```

Check ingress:
```bash
kubectl get ingress -n digital-classroom
```
