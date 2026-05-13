from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from apps.users.api.serializers import UserExchangeKeysSerializer, UserSerializer
from apps.users.models import UserExchangeKeys
from apps.users.services.exchange_tester import (
    SUPPORTED_EXCHANGES,
    ExchangeKeysMissing,
    ExchangeTestError,
    request_test_connection,
    request_test_trade,
)


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


class _ExchangeKeyTestMixin:
    """Shared validation for per-exchange test endpoints."""

    permission_classes = [permissions.IsAuthenticated]

    def _resolve(self, request, exchange: str):
        if exchange not in SUPPORTED_EXCHANGES:
            return None, Response(
                {"detail": f"Unsupported exchange: {exchange}"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        keys, _ = UserExchangeKeys.objects.get_or_create(user=request.user)
        return keys, None


class ExchangeKeyTestConnectionView(_ExchangeKeyTestMixin, APIView):
    """Proxy a read-only key probe to the bot engine."""

    def post(self, request, exchange: str) -> Response:
        keys, error_response = self._resolve(request, exchange)
        if error_response is not None:
            return error_response
        try:
            payload = request_test_connection(keys, exchange)
        except ExchangeKeysMissing as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except ExchangeTestError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(payload)


class ExchangeKeyTestTradeView(_ExchangeKeyTestMixin, APIView):
    """Proxy a round-trip SOL/USDT futures test trade to the bot engine."""

    def post(self, request, exchange: str) -> Response:
        keys, error_response = self._resolve(request, exchange)
        if error_response is not None:
            return error_response
        try:
            payload = request_test_trade(keys, exchange)
        except ExchangeKeysMissing as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except ExchangeTestError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(payload)


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
