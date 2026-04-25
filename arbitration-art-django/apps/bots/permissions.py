from hmac import compare_digest

from django.conf import settings
from rest_framework.permissions import SAFE_METHODS, BasePermission


SERVICE_TOKEN_HEADER = "HTTP_X_SERVICE_TOKEN"


def is_service_request(request) -> bool:
    """Return True when the request carries the configured service token."""

    expected_token = getattr(settings, "SERVICE_SHARED_TOKEN", "")
    provided_token = request.META.get(SERVICE_TOKEN_HEADER, "")
    return bool(expected_token and provided_token and compare_digest(provided_token, expected_token))


class ServiceTokenWriteOrAuthenticatedRead(BasePermission):
    """Allow service-token access for writes and authenticated user reads."""

    def has_permission(self, request, view) -> bool:
        if is_service_request(request):
            return True

        return request.method in SAFE_METHODS and bool(
            request.user and request.user.is_authenticated
        )


class ServiceTokenOnly(BasePermission):
    """Allow only internal service-token requests."""

    def has_permission(self, request, view) -> bool:
        return is_service_request(request)
