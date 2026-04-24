from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from apps.users.api.serializers import UserExchangeKeysSerializer, UserSerializer
from apps.users.models import UserExchangeKeys


class MeView(generics.RetrieveAPIView):
    """Return the authenticated user's profile."""

    serializer_class = UserSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self):
        return self.request.user


class ExchangeKeysView(generics.RetrieveUpdateAPIView):
    """Return masked exchange key state and update current user's keys."""

    serializer_class = UserExchangeKeysSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self):
        exchange_keys, _ = UserExchangeKeys.objects.get_or_create(user=self.request.user)
        return exchange_keys


class LogoutView(APIView):
    """Blacklist the provided refresh token to log the user out."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request) -> Response:
        refresh_token = request.data.get("refresh")
        if not refresh_token:
            return Response(
                {"detail": "Refresh token is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            token = RefreshToken(refresh_token)
            token.blacklist()
        except Exception:
            return Response(
                {"detail": "Invalid or expired token."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(status=status.HTTP_204_NO_CONTENT)
