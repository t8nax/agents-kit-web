using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public sealed class BacklogProposalTests
{
    private const string File = "# Бэклог\r\n\r\nследующий номер: B-4\r\n\r\n## B-1 Первая\r\n\r\nТекст.\r\n\r\n## B-2 Вторая\r\n\r\n## B-3 Третья\r\nХвост.\r\n";

    [Fact]
    public void Blocks_GiveEachEntryItsRangeAndTextWithoutTrailingBlankLines()
    {
        var blocks = Backlog.Blocks(File);

        Assert.Equal(["B-1", "B-2", "B-3"], blocks.Select(b => b.Number));
        Assert.Equal("## B-1 Первая\n\nТекст.", blocks[0].Text);
        Assert.Equal("## B-1 Первая\r\n\r\nТекст.\r\n\r\n", File[blocks[0].Start..blocks[0].End]);
        Assert.Equal(File.Length, blocks[2].End);
    }

    [Fact]
    public void Apply_KeepsWindowsLineEndingsAndCutsLastEntryWithoutHangingBlankLines()
    {
        var (proposal, error) = BacklogProposal.Build(["изменить B-1\n## B-1 Первая, новая\n\nДругой текст.\n", "удалить B-3"], File);
        Assert.Null(error);

        var (text, diverged) = proposal!.Apply(File);

        Assert.Null(diverged);
        Assert.Equal("# Бэклог\r\n\r\nследующий номер: B-4\r\n\r\n## B-1 Первая, новая\r\n\r\nДругой текст.\r\n\r\n## B-2 Вторая\r\n", text);
    }

    [Fact]
    public void Build_RefusesChangedNumberAndEntryNamedTwice()
    {
        Assert.Equal(
            "Изменённая запись B-1 должна начинаться строкой «## B-1 …» и быть одна",
            BacklogProposal.Build(["изменить B-1\n## B-7 Первая"], File).Error);
        Assert.Equal("Запись B-2 названа в предложении дважды", BacklogProposal.Build(["удалить B-2", "удалить B-2"], File).Error);
        Assert.Equal("Непонятная строка предложения: «переписать B-2»", BacklogProposal.Build(["переписать B-2"], File).Error);
    }

    [Fact]
    public void Build_RefusesChangeThatLosesAgentSectionAndMergeIntoDeletedEntry()
    {
        const string withAgent = "# Бэклог\n\n## B-1 Первая\n\nТекст.\n\n### Агенту\n- где: App.tsx\n\n## B-2 Вторая\n";

        Assert.Equal(
            "В изменённой записи B-1 пропал раздел «### Агенту»",
            BacklogProposal.Build(["изменить B-1\n## B-1 Первая\n\nНовый текст."], withAgent).Error);
        Assert.Equal(
            "Запись B-2 уходит в B-1, а B-1 удаляется в том же предложении",
            BacklogProposal.Build(["удалить B-1", "удалить B-2 в B-1"], withAgent).Error);
    }

    [Fact]
    public void Build_RefusesChangeThatLosesArtifactsSection()
    {
        const string withArtifacts = "# Бэклог\n\n## B-1 Первая\n\nТекст.\n\n### Артефакты\n- снимок: artifacts/B-1-снимок.png\n\n### Агенту\n- где: App.tsx\n";

        Assert.Equal(
            "В изменённой записи B-1 пропал раздел «### Артефакты»",
            BacklogProposal.Build(["изменить B-1\n## B-1 Первая\n\nНовый текст.\n\n### Агенту\n- где: App.tsx"], withArtifacts).Error);
        var kept = BacklogProposal.Build(
            ["изменить B-1\n## B-1 Первая\n\nНовый текст.\n\n### Артефакты\n- снимок: artifacts/B-1-снимок.png\n\n### Агенту\n- где: App.tsx"],
            withArtifacts);
        Assert.Null(kept.Error);
        Assert.Equal([new TaskArtifact("снимок", "artifacts/B-1-снимок.png")], kept.Proposal!.Changes[0].Entry.Artifacts);
    }

    [Fact]
    public void Apply_KeepsTrailingSpacesOfChangedEntry()
    {
        var (proposal, _) = BacklogProposal.Build(["изменить B-2\n## B-2 Вторая\n\nСтрока с переносом  \nдальше\n\n"], File);

        var (text, _) = proposal!.Apply(File);

        Assert.Contains("Строка с переносом  \r\nдальше\r\n\r\n## B-3", text);
    }

    [Fact]
    public void Build_RefusesTrackCommandAsUnknownLine()
    {
        // Перенос в трекер предложением больше не бывает — его делает агент сам (AKW-15).
        Assert.Equal("Непонятная строка предложения: «в трекер B-2»", BacklogProposal.Build(["в трекер B-2"], File).Error);
    }

    [Fact]
    public void Moves_TakeMoveBlocksAndLeaveProposalBlocks()
    {
        var (moves, others, error) = BacklogMoves.Take([
            "Перенесена b-2 в youtrack abc-20 https://acme.youtrack.cloud/issue/ABC-20\n",
            "удалить B-1\n",
            "ждет файлов B-3 в GitHub#37 https://github.com/acme/orders/issues/37\n",
            "Ждёт файлов B-1 в github #5 https://github.com/acme/orders/issues/5",
        ]);

        Assert.Null(error);
        Assert.Equal(
            [
                new BacklogMoves.Said("B-2", false, "YouTrack ABC-20", "https://acme.youtrack.cloud/issue/ABC-20"),
                new BacklogMoves.Said("B-3", true, "GitHub #37", "https://github.com/acme/orders/issues/37"),
                new BacklogMoves.Said("B-1", true, "GitHub #5", "https://github.com/acme/orders/issues/5"),
            ],
            moves);
        Assert.Equal(["удалить B-1\n"], others);
    }

    [Theory]
    [InlineData("перенесена B-2 куда-то")]
    [InlineData("перенесена B-2 в YouTrack ABC-20")]
    [InlineData("ждёт файлов B-2 в Jira ABC-20 https://acme.atlassian.net/browse/ABC-20")]
    [InlineData("перенесена нечто в GitHub #3 https://github.com/acme/orders/issues/3")]
    public void Moves_RefuseMoveBlockNotByForm(string command)
    {
        var (moves, others, error) = BacklogMoves.Take(["удалить B-1\n", command + "\n"]);

        Assert.Equal($"Непонятная строка итога переноса: «{command}»", error);
        Assert.Empty(moves);
        Assert.Empty(others);
    }

    [Fact]
    public void Moves_WithoutMoveBlocksGiveAllBlocksBack()
    {
        var (moves, others, error) = BacklogMoves.Take(["удалить B-1\n", "изменить B-2\n## B-2 Вторая\n"]);

        Assert.Null(error);
        Assert.Empty(moves);
        Assert.Equal(["удалить B-1\n", "изменить B-2\n## B-2 Вторая\n"], others);
    }

    [Fact]
    public void Split_TakesProposalBlocksOutOfAnswer()
    {
        var (text, blocks) = BacklogProposal.Split("Вот так.\r\n\r\n~~~backlog\r\nудалить B-2\r\n~~~\r\n\r\n\r\nГотово.");

        Assert.Equal("Вот так.\n\nГотово.", text);
        Assert.Equal(["удалить B-2\n"], blocks);
    }
}
